/**
 * Worker thread backing `etcd3-client.js`. It owns an `etcd3` client and
 * executes primitive gRPC operations (see `etcd3-ops.js`) for the
 * synchronous API surface, which blocks the main thread on `Atomics.wait`
 * (deasync-style libuv re-entrancy is not safe against gRPC completions on
 * recent Node).
 *
 * The protocol is single-flight: the main thread never issues a second
 * request before the previous one returned, because it is blocked while
 * one is outstanding. The Int32 at offset 0 of the shared buffer is the
 * state word:
 *
 *   0   request outstanding (set by the main thread before posting)
 *   1   worker booted, idle
 *   >1  response ready: a UTF-8 JSON document of (value - 1) bytes
 *   -1  worker is exiting (it can no longer answer)
 *
 * The worker writes -1 itself when it exits or hits an uncaught error,
 * because the main thread's `'exit'` event cannot be delivered while the
 * main thread is blocked in `Atomics.wait`.
 */
var parentPort = require('worker_threads').parentPort;
var workerData = require('worker_threads').workerData;
var Etcd3 = require('etcd3').Etcd3;
var etcd3Ops = require('./etcd3-ops');

var header = new Int32Array(workerData.sab, 0, 1);
var bytes = new Uint8Array(workerData.sab, 4);
var MAX_RESPONSE = bytes.length;
var dead = false;


/**
 * Tell a (possibly blocked) main thread that no response will come.
 */
var signalDead = function signalDead () {
    if (dead) return;
    dead = true;
    Atomics.store(header, 0, -1);
    Atomics.notify(header, 0);
};
process.on('exit', signalDead);
process.on('uncaughtException', function () {
    signalDead();
    process.exit(1);
});


var opts = workerData.opts;
if (opts.credentials) {
    var c = opts.credentials;
    // Buffers arrive as plain Uint8Arrays after the structured clone.
    ['rootCertificate', 'privateKey', 'certChain'].forEach(function (k) {
        if (c[k] && !Buffer.isBuffer(c[k])) c[k] = Buffer.from(c[k]);
    });
}

var client = new Etcd3(etcd3Ops.clientOptions(opts, workerData.timeout));
var ops = etcd3Ops.makeOps(client);


/**
 * Write a response into the shared buffer and wake the main thread.
 */
var respond = function respond (id, err, body) {
    var json = JSON.stringify({id: id, err: err, body: body});
    var payload = Buffer.from(json, 'utf8');
    if (dead) return;
    if (payload.length > MAX_RESPONSE) {
        payload = Buffer.from(JSON.stringify({
            id: id,
            err: {message: 'jetconfig: worker response too large'},
            body: null,
        }), 'utf8');
    }
    bytes.set(payload, 0);
    Atomics.store(header, 0, payload.length + 1);
    Atomics.notify(header, 0);
};


/**
 * Serialize an Error into a plain object.
 */
var serializeError = function serializeError (err) {
    return {
        message: err && err.message,
        errorCode: err && err.errorCode !== undefined ?
            err.errorCode : (err && err.code),
        error: err && err.error,
        details: err && err.details,
        cause: err && err.cause,
    };
};


parentPort.on('message', function (msg) {
    var handler = Object.prototype.hasOwnProperty.call(ops, msg.op) ?
        ops[msg.op] : undefined;
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

Atomics.store(header, 0, 1);
Atomics.notify(header, 0);
