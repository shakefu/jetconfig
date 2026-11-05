/**
 * This module implements a small adapter exposing the `node-etcd` client
 * API (etcd v2 HTTP) on top of the `etcd3` package (etcd v3 gRPC).
 *
 * It exists so that the rest of jetconfig can keep its synchronous
 * `getSync`/`setSync` API while talking to an etcd v3 (>= 3.3) server.
 *
 * Blocking strategy: `node-etcd` blocked its synchronous methods with
 * `deasync.loopWhile`. Re-entering the libuv loop that way is not safe
 * against gRPC completions on recent Node versions (nested blocks hang
 * or abort the process), so the synchronous methods here dispatch the
 * gRPC call onto a shared worker thread (see `etcd3-worker.js`) and
 * block the main thread on `Atomics.wait` until the response lands in a
 * shared buffer. This works from any main-thread context, including
 * callbacks.
 *
 * Compatibility notes (v2 -> v3 shims implemented here):
 *
 * - Keys: etcd v2 stored every key with a leading slash (`config/foo`
 *   became `/config/foo`); v3 treats keys as opaque bytes. Every key this
 *   adapter reads or writes is normalized to include the leading slash so
 *   result shapes (and therefore the public jetconfig API) are identical.
 * - Result shapes: calls return `{err, body, headers}` where `body` is a
 *   synthesized v2-style response: `{action, node: {key, value, nodes?,
 *   dir?, modifiedIndex, createdIndex}}`. v3 has no directory nodes, so
 *   `dir` flags and directory listings (`nodes`) are synthesized from key
 *   prefixes.
 * - Errors: not-found is reported as a v2-style error with
 *   `errorCode == 100`, `message` "Key not found" and
 *   `error.cause` holding the key, matching `node-etcd`.
 * - Ordering: v2 returned directory children in creation order; ranges
 *   are therefore sorted by `create_revision` (falling back to key order)
 *   before being shaped.
 * - Recursive GET returns a nested v2-style tree (children nested under
 *   `node.nodes`), which is what `Config.dump()` consumes.
 * - Watchers: etcd3 delivers one stream event per deleted key; etcd v2
 *   delivered a single `delete` event for the directory when a recursive
 *   delete ran. Deletes arriving in the same revision (i.e. from one
 *   ranged delete) are coalesced into a single synthetic directory delete
 *   event.
 * - TTL: `set(key, value, {ttl: n})` grants a fresh one-shot lease per
 *   call (no background keepalive), so keys expire `n` seconds after
 *   their *last* set, matching v2's refresh-on-set behavior. Setting
 *   without `ttl` detaches the key from any lease, as in v2.
 * - Keys and values cross the worker boundary as UTF-8 strings, which is
 *   the only shape jetconfig stores.
 */
var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var Worker = require('worker_threads').Worker;
var Etcd3 = require('etcd3').Etcd3;

// Size of the shared response buffer, in bytes. Responses are JSON
// documents (whole dumps can be sizeable, hence the generous cap).
var WORKER_RESPONSE_BYTES = 16 * 1024 * 1024;


/**
 * Normalize a key to the v2-style leading-slash form.
 */
var normalizeKey = function normalizeKey (key) {
    key = String(key).replace(/^\/+/, '');
    if (key === '') return '/';
    return '/' + key;
};


/**
 * Return the key without trailing slashes (but keeping the root slash).
 * This matches how etcd v2 displayed directory keys.
 */
var trimSlashes = function trimSlashes (key) {
    key = key.replace(/\/+$/, '');
    if (key === '') return '/';
    return key;
};


/**
 * Build a v2-style not found error (errorCode 100).
 */
var notFound = function notFound (key) {
    var err = new Error('Key not found');
    err.errorCode = 100;
    err.error = {errorCode: 100, message: 'Key not found', cause: key};
    return err;
};


/**
 * Map an etcd3 error onto a v2-ish error object. Already-shaped v2
 * errors (e.g. synthesized not-found errors) pass through untouched.
 */
var wrapError = function wrapError (err) {
    var code;
    var message;
    var nice;
    if (err && err.errorCode !== undefined && err.error) return err;
    code = err.errorCode !== undefined ? err.errorCode : err.code;
    message = err.message || (err.details || 'Etcd error');
    nice = new Error(message);
    nice.errorCode = code;
    nice.error = {
        errorCode: code,
        message: message,
        cause: err.cause || err.details,
    };
    return nice;
};


/**
 * Defer a callback to the next loop iteration (macrotask), like the
 * socket-event callbacks node-etcd invoked its callbacks from.
 */
var defer = function defer (fn) {
    setImmediate(fn);
};


/**
 * Convert a worker/serialized KV into a v2-style node object.
 */
var kvToNode = function kvToNode (kv) {
    return {
        key: kv.key,
        value: kv.value,
        modifiedIndex: Number(kv.mr),
        createdIndex: Number(kv.cr),
    };
};


/**
 * Comparator sorting KVs by creation revision, then key. This mirrors
 * etcd v2, which returned children in creation order.
 */
var byCreation = function byCreation (a, b) {
    var diff = Number(a.cr) - Number(b.cr);
    var aKey;
    var bKey;
    if (diff !== 0) return diff;
    aKey = a.key;
    bKey = b.key;
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return 0;
};


/**
 * Insert a KV into a v2-style node tree. Values on directory paths are
 * dropped (v2 keys could not be both a value and a directory); deeper
 * keys convert a leaf node into a directory.
 */
var insertIntoTree = function insertIntoTree (parent, segments, kv) {
    var seg = segments[0];
    var child = null;
    var base = parent.key === '/' ? '' : parent.key;
    var childKey = base + '/' + seg;
    var i;
    for (i = 0; i < parent.nodes.length; i++) {
        if (parent.nodes[i].key === childKey) {
            child = parent.nodes[i];
            break;
        }
    }
    if (child === null) {
        child = {
            key: childKey,
            value: undefined,
            dir: false,
            nodes: undefined,
            modifiedIndex: Number(kv.mr),
            createdIndex: Number(kv.cr),
        };
        parent.nodes.push(child);
    }
    if (segments.length > 1) {
        if (!child.dir) {
            child.dir = true;
            child.value = undefined;
            child.nodes = [];
        }
        insertIntoTree(child, segments.slice(1), kv);
        child.modifiedIndex = Number(kv.mr);
        return;
    }
    if (!child.dir) child.value = kv.value;
    child.modifiedIndex = Number(kv.mr);
};


/**
 * Build the root node of a v2-style tree for `rootKey` from the given
 * (already creation-sorted) KVs underneath it.
 */
var buildTree = function buildTree (rootKey, kvs) {
    var root = {
        key: rootKey,
        dir: true,
        value: undefined,
        nodes: [],
        modifiedIndex: 0,
        createdIndex: 0,
    };
    var prefix = rootKey === '/' ? '/' : rootKey + '/';
    for (var i = 0; i < kvs.length; i++) {
        var path = kvs[i].key.slice(prefix.length);
        if (root.createdIndex === 0) {
            root.createdIndex = Number(kvs[i].cr);
            root.modifiedIndex = Number(kvs[i].mr);
        }
        insertIntoTree(root, path.split('/'), kvs[i]);
    }
    return root;
};


/**
 * Build the v2-style non-recursive directory node for `dirKey` (the
 * immediate children only), from all KVs underneath it.
 */
var buildChildren = function buildChildren (dirKey, kvs) {
    var prefix = dirKey === '/' ? '/' : dirKey + '/';
    var root = {
        key: dirKey,
        dir: true,
        value: undefined,
        nodes: [],
        modifiedIndex: 0,
        createdIndex: 0,
    };
    var seen = {};
    for (var i = 0; i < kvs.length; i++) {
        var rest = kvs[i].key.slice(prefix.length);
        var parts = rest.split('/');
        var seg = parts[0];
        var base = dirKey === '/' ? '' : dirKey;
        var child = seen[seg];
        if (child === undefined) {
            child = {
                key: base + '/' + seg,
                value: undefined,
                dir: false,
                nodes: undefined,
                modifiedIndex: Number(kvs[i].mr),
                createdIndex: Number(kvs[i].cr),
            };
            seen[seg] = child;
            root.nodes.push(child);
        }
        if (parts.length > 1) {
            child.dir = true;
            child.value = undefined;
        }
        else if (!child.dir) {
            child.value = kvs[i].value;
        }
        child.modifiedIndex = Number(kvs[i].mr);
    }
    return root;
};


/**
 * Shape the result of a non-recursive read: an exact leaf, a synthesized
 * directory, or a not-found error.
 */
var shapeImmediate = function shapeImmediate (exactKey, raw) {
    var kvs;
    var node;
    if (raw.exact.length > 0) {
        return {action: 'get', node: kvToNode(raw.exact[0])};
    }
    if (raw.children.length === 0) {
        if (exactKey === '/') {
            return {action: 'get', node: {key: '/', dir: true}};
        }
        throw notFound(exactKey);
    }
    kvs = raw.children.slice().sort(byCreation);
    node = buildChildren(exactKey, kvs);
    node.createdIndex = Number(kvs[0].cr);
    node.modifiedIndex = Number(kvs[0].mr);
    return {action: 'get', node: node};
};


/**
 * Shape the result of a recursive read as a v2-style nested tree.
 */
var shapeRecursive = function shapeRecursive (rootKey, raw) {
    if (raw.kvs.length === 0 && rootKey !== '/') {
        throw notFound(rootKey);
    }
    var kvs = raw.kvs.slice().sort(byCreation);
    return {action: 'get', node: buildTree(rootKey, kvs)};
};


/**
 * Longest common directory prefix of a list of keys, e.g.
 * ['/a/b/c', '/a/b/d'] -> '/a/b/'.
 */
var commonDir = function commonDir (keys) {
    var segs = keys.map(function (key) { return key.split('/'); });
    var common = segs[0];
    for (var i = 1; i < segs.length; i++) {
        var len = Math.min(common.length, segs[i].length);
        var j;
        for (j = 0; j < len; j++) {
            if (common[j] !== segs[i][j]) break;
        }
        common = common.slice(0, j);
    }
    if (common.length <= 1) return '/';
    return common.join('/') + '/';
};


/*******************
 * Worker pool
 */

// Keyed by connection options; every client sharing the same settings
// shares one worker (and one shared buffer).
var workerPool = {};


/**
 * Acquire (or create) the worker serving the given connection options.
 */
var acquireWorker = function acquireWorker (opts) {
    var key = JSON.stringify(opts);
    var entry = workerPool[key];
    if (entry === undefined) {
        var sab = new SharedArrayBuffer(4 + WORKER_RESPONSE_BYTES);
        var worker = new Worker(path.join(__dirname, 'etcd3-worker.js'), {
            workerData: {opts: opts, sab: sab},
        });
        // Unref'd so CLI invocations can exit without closing the client.
        worker.unref();
        worker.on('error', function () {
            // Errors surface as a worker exit; handled there.
        });
        worker.on('exit', function () {
            entry.exited = true;
            // Wake a possibly-blocked caller with the error sentinel.
            Atomics.store(entry.header, 0, -1);
            Atomics.notify(entry.header, 0, 1);
        });
        entry = workerPool[key] = {
            worker: worker,
            sab: sab,
            header: new Int32Array(sab, 0, 1),
            bytes: new Uint8Array(sab, 4),
            refs: 0,
            exited: false,
        };
    }
    entry.refs += 1;
    return entry;
};


/**
 * Release a worker, terminating it once its last client is gone.
 */
var releaseWorker = function releaseWorker (entry) {
    entry.refs -= 1;
    if (entry.refs <= 0) {
        for (var key in workerPool) {
            if (workerPool[key] === entry) delete workerPool[key];
        }
        entry.worker.terminate();
    }
};


/**
 * Run a primitive op on the worker and block until the response lands
 * in the shared buffer. The main thread can never have two requests in
 * flight (it blocks here), so the protocol is single-flight: the Int32
 * at offset 0 holds the ready sentinel/response length (0 means idle).
 */
var callWorker = function callWorker (entry, op, args) {
    var len;
    var res;
    var value;
    if (entry.exited) {
        throw new Error('jetconfig: worker thread exited');
    }
    // Wait for the worker to boot (first call leaves a sentinel).
    while (true) {
        value = Atomics.load(entry.header, 0);
        if (value < 0) {
            throw new Error('jetconfig: worker thread exited');
        }
        if (value !== 0) break;
        Atomics.wait(entry.header, 0, 0);
    }
    if (entry.exited) {
        throw new Error('jetconfig: worker thread exited');
    }
    Atomics.store(entry.header, 0, 0);
    entry.worker.postMessage({op: op, args: args});
    while (true) {
        len = Atomics.load(entry.header, 0);
        if (len < 0) {
            throw new Error('jetconfig: worker thread exited');
        }
        if (len > 1) break;
        Atomics.wait(entry.header, 0, len);
    }
    res = JSON.parse(Buffer.from(entry.sab, 4, len - 1).toString('utf8'));
    if (res.err) throw wrapError(res.err);
    return res.body;
};


/**
 * Convert etcd3 KV messages into plain JSON-serializable objects. (This
 * mirrors the serialization in `etcd3-worker.js` for results arriving
 * over the main-thread client.)
 */
var serializeKvs = function serializeKvs (kvs) {
    var out = [];
    for (var i = 0; i < kvs.length; i++) {
        out.push({
            key: kvs[i].key.toString(),
            value: kvs[i].value === undefined ?
                undefined : kvs[i].value.toString(),
            cr: String(kvs[i].create_revision),
            mr: String(kvs[i].mod_revision),
        });
    }
    return out;
};


/*******************
 * The watcher
 */

/**
 * The watcher. Wraps an etcd3 watcher and translates its events into
 * node-etcd watcher events.
 *
 * @param client {Etcd3Client} - Owning client
 * @param key {String} - Key or prefix to watch
 * @param index {Number=} - v2-style watch index
 * @param opts {Object=} - `{recursive: true}` (default) watches the
 *   prefix, otherwise the exact key
 */
var Etcd3Watcher = function Etcd3Watcher (client, key, index, opts) {
    EventEmitter.call(this);
    var self = this;
    var recursive = !(opts && opts.recursive === false);
    var attempts = 0;
    var norm = normalizeKey(key);

    this.key = key;
    this.stopped = false;
    this._client = client;
    this._watcher = null;
    this._pendingDeletes = [];
    this._flushScheduled = false;
    client._watchers.push(this);

    var create = function create () {
        if (self.stopped) return;
        var builder = client._local.watch();
        if (recursive) builder = builder.prefix(norm);
        else builder = builder.key(norm);
        if (index !== null && index !== undefined) {
            builder = builder.startRevision(Number(index));
        }
        builder.create().then(function (watcher) {
            if (self.stopped) {
                watcher.cancel();
                return;
            }
            self._watcher = watcher;
            watcher.on('put', function (kv) {
                self._onPut(kv);
            });
            watcher.on('delete', function (kv) {
                self._onDelete(kv);
            });
            watcher.on('disconnected', function () {
                self.emit('reconnect',
                    new Error('Connection error, reconnecting.'));
            });
        }, function (err) {
            if (self.stopped) return;
            // Retry like node-etcd's watcher did, with a backoff.
            self.emit('reconnect', wrapError(err));
            attempts += 1;
            var delay = Math.min(300 * Math.pow(2, attempts), 5000);
            var timer = setTimeout(create, delay);
            if (timer.unref) timer.unref();
        });
    };
    create();
};
util.inherits(Etcd3Watcher, EventEmitter);


/**
 * Handle a put event from the stream.
 */
Etcd3Watcher.prototype._onPut = function _onPut (kv) {
    var val = {action: 'set', node: kvToNode(serializeKvs([kv])[0])};
    this.emit('change', val, null);
    this.emit('set', val, null);
};


/**
 * Handle a delete event from the stream. Deletes belonging to a single
 * ranged delete (same revision) are buffered and coalesced into one
 * v2-style directory delete event.
 */
Etcd3Watcher.prototype._onDelete = function _onDelete (kv) {
    this._pendingDeletes.push(serializeKvs([kv])[0]);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    var self = this;
    setImmediate(function () { self._flushDeletes(); });
};


/**
 * Flush buffered delete events, coalescing same-revision deletes.
 */
Etcd3Watcher.prototype._flushDeletes = function _flushDeletes () {
    var groups = {};
    var order = [];
    var pending = this._pendingDeletes;
    this._pendingDeletes = [];
    this._flushScheduled = false;

    for (var i = 0; i < pending.length; i++) {
        var revision = pending[i].mr;
        if (!groups[revision]) {
            groups[revision] = [];
            order.push(revision);
        }
        groups[revision].push(pending[i].key);
    }

    for (var j = 0; j < order.length; j++) {
        var keys = groups[order[j]];
        var val;
        if (keys.length > 1) {
            // One ranged delete: v2 emitted a single directory delete.
            val = {
                action: 'delete',
                node: {
                    key: commonDir(keys),
                    dir: true,
                    modifiedIndex: Number(order[j]),
                },
            };
        }
        else {
            val = {
                action: 'delete',
                node: {
                    key: keys[0],
                    modifiedIndex: Number(order[j]),
                },
            };
        }
        this.emit('change', val, null);
        this.emit('delete', val, null);
    }
};


/**
 * Stop the watcher.
 */
Etcd3Watcher.prototype.stop = function stop () {
    this.stopped = true;
    if (this._watcher) this._watcher.cancel();
    this.emit('stop', "Watcher for '" + this.key + "' aborted.");
};


/*******************
 * The client
 */

/**
 * The client. Mirrors the `node-etcd` API used by jetconfig.
 *
 * @param hosts {String|Array} - host(s), with or without `https?://`
 * @param sslopts {Object} - optional {ca, cert, key, username, password}
 */
var Etcd3Client = function Etcd3Client (hosts, sslopts) {
    var opts = {};
    var credentials;
    var ca;
    sslopts = sslopts || {};
    if (typeof hosts === 'string') hosts = hosts.split(',');
    opts.hosts = hosts.map(function (host) {
        return String(host).replace(/\/+$/, '');
    });

    if (sslopts.ca || sslopts.cert || sslopts.key) {
        credentials = {};
        ca = sslopts.ca;
        if (ca) {
            if (!Array.isArray(ca)) ca = [ca];
            credentials.rootCertificate = Buffer.from(ca.join('\n'));
        }
        if (sslopts.key) {
            credentials.privateKey = Buffer.from(sslopts.key);
        }
        if (sslopts.cert) {
            credentials.certChain = Buffer.from(sslopts.cert);
        }
        opts.credentials = credentials;
    }

    if (sslopts.username && sslopts.password) {
        opts.auth = {
            username: sslopts.username,
            password: sslopts.password,
        };
    }

    this.hosts = opts.hosts.slice();
    // Main-thread client for asynchronous calls and watchers...
    this._local = new Etcd3(opts);
    // ...and a shared worker for the blocking calls.
    this._worker = acquireWorker(opts);
    this._watchers = [];
};


/**
 * Synchronous get. Returns `{err, body, headers}`.
 */
Etcd3Client.prototype.getSync = function getSync (key, opts) {
    opts = opts || {};
    var norm = normalizeKey(key);
    try {
        var body;
        if (opts.recursive === true) {
            body = shapeRecursive(trimSlashes(norm),
                callWorker(this._worker, 'getRecursive', {prefix: norm}));
        }
        else {
            body = shapeImmediate(trimSlashes(norm),
                callWorker(this._worker, 'getImmediate',
                    {key: norm, exactKey: trimSlashes(norm)}));
        }
        return {err: null, body: body, headers: {}};
    }
    catch (err) {
        return {err: wrapError(err), body: '', headers: {}};
    }
};


/**
 * Asynchronous get. Callback receives `(err, body, headers)`.
 */
Etcd3Client.prototype.get = function get (key, opts, callback) {
    if (typeof opts === 'function') {
        callback = opts;
        opts = undefined;
    }
    var self = this;
    var norm = normalizeKey(key);
    var exactKey = trimSlashes(norm);
    var promise;
    if (opts && opts.recursive === true) {
        promise = this._local.getAll().prefix(norm).exec()
            .then(function (res) {
                return shapeRecursive(exactKey, {kvs: serializeKvs(res.kvs)});
            });
    }
    else {
        var childPrefix = norm;
        if (!/\/$/.test(childPrefix)) childPrefix += '/';
        promise = this._local.get(exactKey).exec().then(function (res) {
            var exact = serializeKvs(res.kvs);
            return self._local.getAll().prefix(childPrefix).exec()
                .then(function (children) {
                    return shapeImmediate(exactKey, {
                        exact: exact,
                        children: serializeKvs(children.kvs),
                    });
                });
        });
    }
    promise.then(function (body) {
        defer(function () { callback(null, body, {}); });
    }, function (err) {
        defer(function () { callback(wrapError(err), '', {}); });
    });
};


/**
 * Synchronous set. Returns `{err, body, headers}`.
 */
Etcd3Client.prototype.setSync = function setSync (key, value, opts) {
    var norm = normalizeKey(key);
    var ttl = opts ? Number(opts.ttl) : NaN;
    try {
        var raw = callWorker(this._worker, 'put',
            {key: norm, value: value, ttl: ttl});
        var revision = Number(raw.revision);
        return {
            err: null,
            headers: {},
            body: {
                action: 'set',
                node: {
                    key: norm,
                    value: value,
                    modifiedIndex: revision,
                    createdIndex: revision,
                },
            },
        };
    }
    catch (err) {
        return {err: wrapError(err), body: '', headers: {}};
    }
};


/**
 * Asynchronous set. Callback receives `(err, body, headers)`.
 */
Etcd3Client.prototype.set = function set (key, value, opts, callback) {
    if (typeof opts === 'function') {
        callback = opts;
        opts = undefined;
    }
    var norm = normalizeKey(key);
    var ttl = opts ? Number(opts.ttl) : NaN;
    var promise;
    if (ttl >= 1) {
        // A fresh lease per set; no keepalive, so the key expires `ttl`
        // seconds after its last set (v2 refresh-on-set semantics).
        promise = this._local.lease(ttl, {autoKeepAlive: false})
            .put(norm).value(value);
    }
    else {
        // A put without a lease detaches the key from any existing one.
        promise = this._local.put(norm).value(value).exec();
    }
    promise.then(function (res) {
        var revision = res && res.header ? Number(res.header.revision) : 0;
        var body = {
            action: 'set',
            node: {
                key: norm,
                value: value,
                modifiedIndex: revision,
                createdIndex: revision,
            },
        };
        defer(function () { callback(null, body, {}); });
    }, function (err) {
        defer(function () { callback(wrapError(err), '', {}); });
    });
};


/**
 * Synchronous delete. Returns `{err, body, headers}`.
 */
Etcd3Client.prototype.delSync = function delSync (key, opts) {
    var norm = normalizeKey(key);
    var recursive = !!(opts && opts.recursive === true);
    var delKey = trimSlashes(norm);
    try {
        var raw = callWorker(this._worker, 'delete',
            {key: recursive ? norm : delKey, recursive: recursive});
        var deleted = Number(raw.deleted);
        if (deleted === 0) throw notFound(delKey);
        var revision = Number(raw.revision);
        var node = {
            key: delKey,
            modifiedIndex: revision,
            createdIndex: revision,
        };
        if (recursive) node.dir = true;
        return {
            err: null,
            headers: {},
            body: {action: 'delete', node: node},
        };
    }
    catch (err) {
        return {err: wrapError(err), body: '', headers: {}};
    }
};


/**
 * Synchronous directory delete (delegates to delSync).
 */
Etcd3Client.prototype.rmdirSync = function rmdirSync (key, opts) {
    return this.delSync(key, opts);
};


/**
 * Asynchronous delete. Callback receives `(err, body, headers)`.
 */
Etcd3Client.prototype.del = function del (key, opts, callback) {
    if (typeof opts === 'function') {
        callback = opts;
        opts = undefined;
    }
    var norm = normalizeKey(key);
    var recursive = !!(opts && opts.recursive === true);
    var delKey = trimSlashes(norm);
    var promise = recursive ?
        this._local.delete().prefix(norm).exec() :
        this._local.delete().key(delKey).exec();
    promise.then(function (res) {
        var deleted = res && res.deleted ? Number(res.deleted) : 0;
        if (deleted === 0) throw notFound(delKey);
        var revision = res.header ? Number(res.header.revision) : 0;
        var node = {
            key: delKey,
            modifiedIndex: revision,
            createdIndex: revision,
        };
        if (recursive) node.dir = true;
        defer(function () {
            callback(null, {action: 'delete', node: node}, {});
        });
    }, function (err) {
        defer(function () { callback(wrapError(err), '', {}); });
    });
};
Etcd3Client.prototype['delete'] = Etcd3Client.prototype.del;


/**
 * Return a copy of the configured hosts.
 */
Etcd3Client.prototype.getHosts = function getHosts () {
    return this.hosts.slice();
};


/**
 * Create a watcher on a key or prefix. Emits v2-style node-etcd watcher
 * events: 'change' (for every update, first), the action name
 * ('set'/'delete'), and 'stop' when stopped.
 *
 * @param key {String} - Key or prefix to watch
 * @param index {Number=} - v2-style watch index; mapped to a start
 *   revision when provided
 * @param opts {Object=} - `{recursive: true}` watches a prefix (the
 *   default), otherwise the exact key
 */
Etcd3Client.prototype.watcher = function watcher (key, index, opts) {
    return new Etcd3Watcher(this, key, index, opts);
};


/**
 * Close the client and all its watchers.
 */
Etcd3Client.prototype.close = function close () {
    this._watchers.slice().forEach(function (watcher) {
        watcher.stop();
    });
    releaseWorker(this._worker);
    this._local.close();
};


module.exports = Etcd3Client;
