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
 * callbacks. Every unary call carries a gRPC deadline, and a blocked call
 * gives up (replacing the worker) if the worker stops answering, so a
 * synchronous call can never block forever.
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
 *   delete ran. Multiple deletes in the same revision (i.e. from one
 *   ranged delete) are coalesced into a single directory delete event for
 *   the watched root, and all events are emitted in revision order.
 * - TTL: `set(key, value, {ttl: n})` grants a fresh one-shot lease per
 *   call (no background keepalive), so keys expire `n` seconds after
 *   their *last* set, matching v2's refresh-on-set behavior. Setting
 *   without `ttl` detaches the key from any lease, as in v2.
 * - Recursive reads and deletes cover the key itself and everything
 *   below `key/` (never siblings such as `keyother`), and a recursive
 *   delete runs as one transaction.
 * - Keys and values cross the worker boundary as UTF-8 strings, which is
 *   the only shape jetconfig stores. The primitive ops live in
 *   `etcd3-ops.js`, shared by the worker and the asynchronous methods.
 */
var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var Worker = require('worker_threads').Worker;
var Etcd3 = require('etcd3').Etcd3;
var etcd3Ops = require('./etcd3-ops');
var serializeKvs = etcd3Ops.serializeKvs;

// Size of the shared response buffer, in bytes. Responses are JSON
// documents (whole dumps can be sizeable, hence the generous cap); a
// response larger than this fails with "worker response too large".
var WORKER_RESPONSE_BYTES = 16 * 1024 * 1024;

// Deadline for each unary etcd call attempt, in milliseconds. etcd3 retries
// a timed-out call, so an unreachable cluster fails after ~3x this.
var REQUEST_TIMEOUT_MS = 5000;

// Backstop for a blocking call: the gRPC deadline should always fire
// first, but etcd3 retries some failures (up to 3 attempts), and the
// main thread must never block forever if the worker stops answering.
var WORKER_BACKSTOP_MS = 3 * REQUEST_TIMEOUT_MS + 5000;


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
    var kvs;
    if (raw.children.length === 0) {
        if (raw.exact.length > 0) {
            return {action: 'get', node: kvToNode(raw.exact[0])};
        }
        if (rootKey !== '/') throw notFound(rootKey);
    }
    kvs = raw.children.slice().sort(byCreation);
    return {action: 'get', node: buildTree(rootKey, kvs)};
};


/**
 * Shape a read result, recursive or not.
 */
var shapeRead = function shapeRead (exactKey, recursive, raw) {
    if (recursive) return shapeRecursive(exactKey, raw);
    return shapeImmediate(exactKey, raw);
};


/**
 * Shape the result of a set.
 */
var shapeSet = function shapeSet (key, value, raw) {
    var revision = Number(raw.revision);
    return {
        action: 'set',
        node: {
            key: key,
            value: value,
            modifiedIndex: revision,
            createdIndex: revision,
        },
    };
};


/**
 * Shape the result of a delete (or a not-found error if nothing was
 * deleted).
 */
var shapeDelete = function shapeDelete (key, recursive, raw) {
    var revision = Number(raw.revision);
    var node;
    if (Number(raw.deleted) === 0) throw notFound(key);
    node = {key: key, modifiedIndex: revision, createdIndex: revision};
    if (recursive) node.dir = true;
    return {action: 'delete', node: node};
};


/*******************
 * Worker pool
 */

// Keyed by connection options; every client sharing the same settings
// shares one worker (and one shared buffer).
var workerPool = {};


/**
 * Start a fresh worker (and shared buffer) for a pool entry, replacing
 * any previous one. The previous worker is terminated; it writes into its
 * own buffer, so a late response from it can never be mistaken for one
 * from the new worker.
 */
var spawnWorker = function spawnWorker (entry) {
    var old = entry.worker;
    var sab = new SharedArrayBuffer(4 + WORKER_RESPONSE_BYTES);
    var header = new Int32Array(sab, 0, 1);
    var worker = new Worker(path.join(__dirname, 'etcd3-worker.js'), {
        workerData: {opts: entry.opts, timeout: entry.timeout, sab: sab},
    });
    // Unref'd so CLI invocations can exit without closing the client.
    worker.unref();
    worker.on('error', function () {
        // Errors surface as a worker exit; handled there.
    });
    worker.on('exit', function () {
        // Mark the buffer dead; the worker normally did this itself.
        Atomics.store(header, 0, -1);
        Atomics.notify(header, 0);
    });
    entry.worker = worker;
    entry.sab = sab;
    entry.header = header;
    if (old) old.terminate();
};


/**
 * Acquire (or create) the worker serving the given connection options.
 */
var acquireWorker = function acquireWorker (opts, timeout) {
    var key = JSON.stringify({opts: opts, timeout: timeout});
    var entry = workerPool[key];
    if (entry === undefined) {
        entry = workerPool[key] = {
            key: key,
            opts: opts,
            timeout: timeout,
            worker: null,
            sab: null,
            header: null,
            refs: 0,
            seq: 0,
        };
        spawnWorker(entry);
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
        if (workerPool[entry.key] === entry) delete workerPool[entry.key];
        entry.worker.terminate();
    }
};


/**
 * Block until the state word leaves `waitingOn` (or the deadline passes).
 * Returns the new state, or `null` on timeout.
 */
var awaitState = function awaitState (header, waitingOn, deadline) {
    var value;
    var remaining;
    while (true) {
        value = Atomics.load(header, 0);
        if (waitingOn.indexOf(value) === -1) return value;
        remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        Atomics.wait(header, 0, value, remaining);
    }
};


/**
 * Run a primitive op on the worker and block until the response lands
 * in the shared buffer. The main thread can never have two requests in
 * flight (it blocks here), so the protocol is single-flight; see
 * `etcd3-worker.js` for the meaning of the state word.
 *
 * A worker that died is replaced before the next call; a worker that
 * stops answering is replaced once the backstop deadline passes.
 */
var callWorker = function callWorker (entry, op, args) {
    var deadline = Date.now() + WORKER_BACKSTOP_MS;
    var id;
    var header;
    var sab;
    var state;
    var res;

    if (Atomics.load(entry.header, 0) < 0) spawnWorker(entry);
    header = entry.header;
    sab = entry.sab;

    // Wait for the worker to boot (it then leaves the idle sentinel).
    state = awaitState(header, [0], deadline);
    if (state === null || state < 0) {
        spawnWorker(entry);
        throw new Error(state === null ?
            'jetconfig: etcd worker did not start' :
            'jetconfig: etcd worker exited');
    }

    id = ++entry.seq;
    Atomics.store(header, 0, 0);
    entry.worker.postMessage({id: id, op: op, args: args});

    state = awaitState(header, [0, 1], deadline);
    if (state === null || state < 0) {
        spawnWorker(entry);
        throw new Error(state === null ?
            'jetconfig: etcd request timed out' :
            'jetconfig: etcd worker exited');
    }

    res = JSON.parse(Buffer.from(sab, 4, state - 1).toString('utf8'));
    if (res.id !== id) {
        spawnWorker(entry);
        throw new Error('jetconfig: etcd worker protocol error');
    }
    if (res.err) throw wrapError(res.err);
    return res.body;
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
    // Root of the watched range, in v2 display form. Ranged deletes are
    // reported against it (see `_onData`).
    this._root = trimSlashes(norm);
    client._watchers.push(this);

    var retry; // retry(err), defined below
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
            attempts = 0;
            self._watcher = watcher;
            // Consume whole stream responses (rather than the per-event
            // 'put'/'delete' events) so that events keep their revision
            // order and one ranged delete can be coalesced synchronously.
            watcher.on('data', function (res) {
                self._onData(res);
            });
            watcher.on('disconnected', function () {
                self.emit('reconnect',
                    new Error('Connection error, reconnecting.'));
            });
            // etcd cancelled the watch (e.g. compaction or permissions).
            // Without a listener this 'error' would crash the process, so
            // report it as a reconnect and re-establish the watch.
            watcher.on('error', function (err) {
                if (self.stopped) return;
                self._watcher = null;
                // A start revision that was compacted away would fail
                // again forever; resume from the current revision.
                index = null;
                retry(err);
            });
        }, function (err) {
            if (self.stopped) return;
            retry(err);
        });
    };
    retry = function retry (err) {
        // Retry like node-etcd's watcher did, with a backoff.
        self.emit('reconnect', wrapError(err));
        attempts += 1;
        var delay = Math.min(300 * Math.pow(2, attempts), 5000);
        var timer = setTimeout(create, delay);
        if (timer.unref) timer.unref();
    };
    create();
};
util.inherits(Etcd3Watcher, EventEmitter);


/**
 * Handle one watch stream response. Events are emitted in revision order.
 * etcd v3 reports a ranged delete as one delete event per key, all sharing
 * the same revision, whereas etcd v2 emitted a single directory delete;
 * such a group is coalesced into one directory delete for the watched
 * root. v3 does not say which range was deleted, so reporting the watched
 * root may over-invalidate (a subdirectory delete clears more than it
 * strictly needs to), which is safe for cache consumers, unlike reporting
 * a narrower key that would leave deleted keys behind.
 */
Etcd3Watcher.prototype._onData = function _onData (res) {
    var events = (res && res.events) || [];
    var deletes = [];
    var self = this;

    var flush = function flush () {
        var val;
        if (deletes.length === 0) return;
        if (deletes.length > 1) {
            val = {
                action: 'delete',
                node: {
                    key: self._root,
                    dir: true,
                    modifiedIndex: Number(deletes[0].mr),
                },
            };
        }
        else {
            val = {
                action: 'delete',
                node: {
                    key: deletes[0].key,
                    modifiedIndex: Number(deletes[0].mr),
                },
            };
        }
        deletes = [];
        self.emit('change', val, null);
        self.emit('delete', val, null);
    };

    for (var i = 0; i < events.length; i++) {
        var kv = serializeKvs([events[i].kv])[0];
        var type = String(events[i].type).toLowerCase();
        // A prefix watch on `/config` also sees `/configuration`; v2
        // directory watches did not.
        if (!this._inRange(kv.key)) continue;
        if (type === 'delete') {
            if (deletes.length > 0 && deletes[0].mr !== kv.mr) flush();
            deletes.push(kv);
            continue;
        }
        flush();
        if (type === 'put') {
            var val = {action: 'set', node: kvToNode(kv)};
            this.emit('change', val, null);
            this.emit('set', val, null);
        }
    }
    flush();
};


/**
 * Whether `key` is the watched key or below it.
 */
Etcd3Watcher.prototype._inRange = function _inRange (key) {
    var root = this._root;
    if (root === '/' || key === root) return true;
    return key.slice(0, root.length + 1) === root + '/';
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
    this.closed = false;
    // Main-thread client for asynchronous calls and watchers...
    this._local = new Etcd3(etcd3Ops.clientOptions(opts, REQUEST_TIMEOUT_MS));
    this._ops = etcd3Ops.makeOps(this._local);
    // ...and a shared worker for the blocking calls.
    this._worker = acquireWorker(opts, REQUEST_TIMEOUT_MS);
    this._watchers = [];
};


/**
 * Run a primitive op synchronously on the worker and shape its result.
 * Returns `{err, body, headers}`.
 */
Etcd3Client.prototype._sync = function _sync (op, args, shape) {
    try {
        return {
            err: null,
            body: shape(callWorker(this._worker, op, args)),
            headers: {},
        };
    }
    catch (err) {
        return {err: wrapError(err), body: '', headers: {}};
    }
};


/**
 * Run a primitive op asynchronously on the main-thread client, shape its
 * result, and invoke the node-etcd style `(err, body, headers)` callback.
 */
Etcd3Client.prototype._async = function _async (op, args, shape, callback) {
    var promise;
    try {
        promise = this._ops[op](args).then(shape);
    }
    catch (err) {
        promise = Promise.reject(err);
    }
    promise.then(function (body) {
        defer(function () { callback(null, body, {}); });
    }, function (err) {
        defer(function () { callback(wrapError(err), '', {}); });
    });
};


/**
 * Synchronous get. Returns `{err, body, headers}`.
 */
Etcd3Client.prototype.getSync = function getSync (key, opts) {
    var exactKey = trimSlashes(normalizeKey(key));
    var recursive = !!(opts && opts.recursive === true);
    return this._sync('read', {key: exactKey}, function (raw) {
        return shapeRead(exactKey, recursive, raw);
    });
};


/**
 * Asynchronous get. Callback receives `(err, body, headers)`.
 */
Etcd3Client.prototype.get = function get (key, opts, callback) {
    if (typeof opts === 'function') {
        callback = opts;
        opts = undefined;
    }
    var exactKey = trimSlashes(normalizeKey(key));
    var recursive = !!(opts && opts.recursive === true);
    this._async('read', {key: exactKey}, function (raw) {
        return shapeRead(exactKey, recursive, raw);
    }, callback);
};


/**
 * Synchronous set. Returns `{err, body, headers}`.
 */
Etcd3Client.prototype.setSync = function setSync (key, value, opts) {
    var norm = normalizeKey(key);
    var ttl = opts ? Number(opts.ttl) : NaN;
    return this._sync('put', {key: norm, value: value, ttl: ttl},
        function (raw) { return shapeSet(norm, value, raw); });
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
    this._async('put', {key: norm, value: value, ttl: ttl},
        function (raw) { return shapeSet(norm, value, raw); }, callback);
};


/**
 * Synchronous delete. Returns `{err, body, headers}`. With
 * `{recursive: true}` the key and everything below `key/` is deleted.
 */
Etcd3Client.prototype.delSync = function delSync (key, opts) {
    var delKey = trimSlashes(normalizeKey(key));
    var recursive = !!(opts && opts.recursive === true);
    return this._sync('delete', {key: delKey, recursive: recursive},
        function (raw) { return shapeDelete(delKey, recursive, raw); });
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
    var delKey = trimSlashes(normalizeKey(key));
    var recursive = !!(opts && opts.recursive === true);
    this._async('delete', {key: delKey, recursive: recursive},
        function (raw) { return shapeDelete(delKey, recursive, raw); },
        callback);
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
    // Closing twice must not release the shared worker twice.
    if (this.closed) return;
    this.closed = true;
    this._watchers.slice().forEach(function (watcher) {
        watcher.stop();
    });
    releaseWorker(this._worker);
    this._local.close();
};


module.exports = Etcd3Client;
