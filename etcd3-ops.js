/**
 * Primitive etcd v3 operations shared by `etcd3-client.js` (asynchronous
 * calls on the main thread) and `etcd3-worker.js` (the blocking calls).
 *
 * Every op takes plain JSON arguments and resolves to a plain
 * JSON-serializable object, so results can cross the worker boundary.
 * Keys and values are exchanged as UTF-8 strings, which is what jetconfig
 * stores. (`etcd3` keys are bytes; non-UTF-8 keys would be corrupted in
 * transit, but they cannot be represented through the v2-shaped API the
 * client emulates anyway.)
 */
var Range = require('etcd3').Range;


/**
 * Return a copy of the `etcd3` client options with a per-call deadline
 * applied to every unary call (streams, i.e. watchers and lease
 * keepalives, are left alone). Without a deadline a call against an
 * unreachable host can block for minutes.
 *
 * @param opts {Object} - `etcd3` options (JSON-serializable)
 * @param timeout {Number} - Per-call deadline in milliseconds
 */
var clientOptions = function clientOptions (opts, timeout) {
    var out = {};
    for (var key in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, key)) {
            out[key] = opts[key];
        }
    }
    out.defaultCallOptions = function defaultCallOptions (context) {
        if (context.isStream) return {};
        return {deadline: Date.now() + timeout};
    };
    return out;
};


/**
 * Convert etcd3 KV messages into plain JSON-serializable objects.
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


/**
 * The directory prefix holding the children of `exactKey`.
 */
var childPrefix = function childPrefix (exactKey) {
    return exactKey === '/' ? '/' : exactKey + '/';
};


var revisionOf = function revisionOf (res) {
    return res && res.header ? String(res.header.revision) : '0';
};


/**
 * Build the primitive ops bound to an `etcd3` client.
 *
 * Keys are passed in the v2 display form (leading slash, no trailing
 * slash, `'/'` for the root). Children are always matched below
 * `key + '/'`, so `/config` never matches `/configuration`.
 */
var makeOps = function makeOps (client) {
    return {
        /**
         * Read the exact key and everything below it.
         */
        read: function read (args) {
            return client.get(args.key).exec().then(function (res) {
                return client.getAll().prefix(childPrefix(args.key)).exec()
                    .then(function (children) {
                        return {
                            exact: serializeKvs(res.kvs),
                            children: serializeKvs(children.kvs),
                        };
                    });
            });
        },

        put: function put (args) {
            var builder;
            if (args.ttl >= 1) {
                // A fresh lease per set; no keepalive, so the key expires
                // `ttl` seconds after its last set (v2 refresh-on-set).
                builder = client.lease(args.ttl, {autoKeepAlive: false})
                    .put(args.key).value(args.value);
            }
            else {
                // A put without a lease detaches the key from any lease.
                builder = client.put(args.key).value(args.value);
            }
            return builder.exec().then(function (res) {
                return {revision: revisionOf(res)};
            });
        },

        /**
         * Delete the exact key, and with `recursive` everything below it,
         * in a single transaction (one revision, as v2's recursive delete
         * was one operation).
         */
        'delete': function _delete (args) {
            var range;
            if (args.recursive && args.key === '/') {
                // Everything is below the root; one ranged delete.
                return client.delete().prefix('/').exec()
                    .then(function (res) {
                        return {
                            deleted: res && res.deleted ?
                                String(res.deleted) : '0',
                            revision: revisionOf(res),
                        };
                    });
            }
            if (!args.recursive) {
                return client.delete().key(args.key).exec()
                    .then(function (res) {
                        return {
                            deleted: res && res.deleted ?
                                String(res.deleted) : '0',
                            revision: revisionOf(res),
                        };
                    });
            }
            range = Range.prefix(childPrefix(args.key));
            return client.kv.txn({
                success: [
                    {request_delete_range: {key: Buffer.from(args.key)}},
                    {request_delete_range: {
                        key: range.start,
                        range_end: range.end,
                    }},
                ],
            }).then(function (res) {
                var deleted = 0;
                (res.responses || []).forEach(function (op) {
                    if (op.response_delete_range) {
                        deleted += Number(op.response_delete_range.deleted);
                    }
                });
                return {deleted: String(deleted), revision: revisionOf(res)};
            });
        },
    };
};


exports.clientOptions = clientOptions;
exports.serializeKvs = serializeKvs;
exports.makeOps = makeOps;
