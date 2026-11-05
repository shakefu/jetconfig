/**
 * Worker thread backing `etcd3-client.js`. It owns an `etcd3` client and
 * executes primitive gRPC operations for the synchronous API surface,
 * which blocks the main thread on `Atomics.wait` (deasync-style libuv
 * re-entrancy is not safe against gRPC completions on recent Node).
 *
 * The protocol is single-flight: the main thread never issues a second
 * request before the previous one returned, because it is blocked while
 * one is outstanding. Results are written into a shared buffer as a
 * UTF-8 JSON document, headed by an Int32 length at offset 0 (zero means
 * "no result yet"); the worker then notifies the main thread.
 *
 * Keys and values are exchanged as UTF-8 strings, which is what
 * jetconfig stores. (`etcd3` keys are bytes; non-UTF-8 keys would be
 * corrupted in transit, but they cannot be represented through the
 * v2-shaped API this adapter emulates anyway.)
 */
var parentPort = require('worker_threads').parentPort;
var workerData = require('worker_threads').workerData;
var Etcd3 = require('etcd3').Etcd3;

// Credentials arrive structured-cloned as Uint8Arrays; grpc wants
// Buffers (or at least real byte sources), so normalize them.
var opts = workerData.opts;
if (opts.credentials) {
    var c = opts.credentials;
    ['rootCertificate', 'privateKey', 'certChain'].forEach(function (k) {
        if (c[k] && !Buffer.isBuffer(c[k])) c[k] = Buffer.from(c[k]);
    });
}

var header = new Int32Array(workerData.sab, 0, 1);
var bytes = new Uint8Array(workerData.sab, 4);
var client = new Etcd3(opts);

var MAX_RESPONSE = bytes.length;


/**
 * Convert etcd3 KV messages into plain JSON-serializable objects.
 */
function serializeKvs (kvs) {
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
}


/**
 * Serialize the primitive ops the main thread can ask for. Each returns
 * a plain JSON-serializable object.
 */
var ops = {
    // Exact-key GET plus the children scan used to emulate v2
    // non-recursive reads. Resolves with two lists of KVs.
    getImmediate: function getImmediate (args) {
        var childPrefix = args.key;
        if (!/\/$/.test(childPrefix)) childPrefix += '/';
        return client.get(args.exactKey).exec().then(function (res) {
            return client.getAll().prefix(childPrefix).exec()
                .then(function (children) {
                    return {
                        exact: serializeKvs(res.kvs),
                        children: serializeKvs(children.kvs),
                    };
                });
        });
    },
    // Prefix GET, used for recursive reads.
    getRecursive: function getRecursive (args) {
        return client.getAll().prefix(args.prefix).exec()
            .then(function (res) {
                return {kvs: serializeKvs(res.kvs)};
            });
    },
    // PUT with an optional one-shot lease (ttl in seconds).
    put: function put (args) {
        var promise;
        if (args.ttl >= 1) {
            promise = client.lease(args.ttl, {autoKeepAlive: false})
                .put(args.key).value(args.value);
        }
        else {
            promise = client.put(args.key).value(args.value).exec();
        }
        return promise.then(function (res) {
            return {revision: res && res.header ?
                String(res.header.revision) : '0'};
        });
    },
    // DELETE of an exact key or an entire prefix.
    'delete': function _delete (args) {
        var promise = args.recursive ?
            client.delete().prefix(args.key).exec() :
            client.delete().key(args.key).exec();
        return promise.then(function (res) {
            return {
                deleted: res && res.deleted ? String(res.deleted) : '0',
                revision: res && res.header ?
                    String(res.header.revision) : '0',
            };
        });
    },
};


/**
 * Write a response into the shared buffer and wake the main thread.
 */
function respond (id, err, body) {
    var json = JSON.stringify({id: id, err: err, body: body});
    var payload = Buffer.from(json, 'utf8');
    if (payload.length > MAX_RESPONSE) {
        payload = Buffer.from(JSON.stringify({
            id: id,
            err: {message: 'jetconfig: worker response too large'},
            body: null,
        }), 'utf8');
    }
    bytes.set(payload, 0);
    Atomics.store(header, 0, payload.length + 1);
    Atomics.notify(header, 0, 1);
}


/**
 * Serialize an Error into a plain object.
 */
function serializeError (err) {
    return {
        message: err && err.message,
        errorCode: err && err.errorCode !== undefined ?
            err.errorCode : (err && err.code),
        error: err && err.error,
        details: err && err.details,
        cause: err && err.cause,
    };
}


parentPort.on('message', function (msg) {
    var handler = ops[msg.op];
    Promise.resolve().then(function () {
        if (!handler) {
            throw new Error('jetconfig: unknown worker op ' + msg.op);
        }
        return handler(msg.args);
    }).then(function (body) {
        respond(msg.id, null, body);
    }, function (err) {
        respond(msg.id, serializeError(err), null);
    });
});


// Signal readiness: the main thread blocks on this flag (offset 0 holds
// either a response length + 1 or, before the first request, the ready
// sentinel written here).
Atomics.store(header, 0, 1);
Atomics.notify(header, 0, 1);
