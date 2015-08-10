/**
 * This module contains the Config class and its helpers.
 *
 */
var _ = require('lodash');
var assert = require('assert');
var Log = require('./log');
var Etcd = require('node-etcd');


/**
 * Create a new config instance backed by etcd
 */
var init; // init(hosts, opts)
var Config = function Config (hosts, opts) {
    assert(this instanceof Config, "Missing 'new' keyword");
    init.call(this, hosts, opts);
};
exports.Config = Config;


/**
 * Return a config value for `key`.
 *
 * @param key {string} - Dot notation key name
 * @param def - Default value if key is not found
 * @param opts {Object} - Options to use (optional)
 * @param callback {Function=} - Callback (optional)
 */
Config.prototype.get = function get (key, def, opts, callback) {
    var cacheEnabled = this.cacheEnabled;
    var cacheResult = cacheEnabled;
    var result;

    assert(_.isString(key), "key must be a String");

    // Handle when there's no default, only a callback
    if (_.isFunction(def)) {
        callback = def;
        def = undefined;
    }

    // Handle when there's no options but a callback is provided
    if (_.isFunction(opts)) {
        callback = opts;
        opts = undefined;
    }

    // Check whether we're allowed to use the local cache
    if (opts && opts.cached !== undefined) {
        cacheEnabled = opts.cached;
        delete opts.cache;
    }

    // Check whether we're allowed to locally cache the result
    if (opts && opts.cacheResult !== undefined) {
        cacheResult = opts.cacheResult;
        delete opts.cacheResult;
    }

    // Check if we're using the local cache
    if (cacheEnabled && this.cache[key] !== undefined) {
        result = this.cache[key];
        this.log.debug('get', '/' + this.prefix + key, result, '(cached)');
        if (!_.isFunction(callback)) return result;
        return callback(null, result);
    }

    // Handle calling synchronously
    if (!_.isFunction(callback)) {
        result = this.client().getSync(this.prefix + key);
        this.log.silly("etcd get result:", result);
        result = this._parseResult(result);
        if (result === undefined) {
            this.log.debug('get', '/' + this.prefix + key, def, def !==
                    undefined ? '(default)' : '');
            if (cacheResult && def !== undefined) this.cache[key] = def;
            return def;
        }
        if (cacheResult) this.cache[key] = result;
        return result;
    }

    // Handle async/callbck
    assert(_.isFunction(callback), "callback must be a Function");

    this.client().get(this.prefix + key, function (err, result) {
        result = {err: err, body: result};
        this.log.silly("etcd get async result:", result);
        try {
            result = this._parseResult(result); 
        }
        catch (err) {
            callback(err);
        }
        if (result === undefined){
            this.log.debug('get', '/' + this.prefix + key, def, '(default)');
            if (cacheResult) this.cache[key] = def;
            return callback(null, def);
        }
        if (cacheResult) this.cache[key] = result;
        callback(null, result);
    }.bind(this));
};


/**
 * Set a new value for `key`
 *
 * @param key {String} - Dot notation key name
 * @param value - New value to set (must be JSON serializable)
 */
Config.prototype.set = function set (key, value, opts, callback) {
    var cacheOnly;
    var result;
    var json_value;

    assert(_.isString(key), "key must be a String");

    if (!_.isString(value)) json_value = JSON.stringify(value);
    else json_value = value;

    if (_.isFunction(opts)) {
        callback = opts;
        opts = undefined;
    }

    if (opts && opts.cacheOnly !== undefined) {
        cacheOnly = opts.cacheOnly;
        delete opts.cacheOnly;
    }

    this.log.debug('set', '/' + this.prefix + key, json_value, cacheOnly ?
            '(cache only)' : '');

    // Only update things locally, do not write to etcd
    if (cacheOnly) {
        if (this.cacheEnabled) this.cache[key] = value;
        if (!_.isFunction(callback)) return this;
        return callback(null, value);
    }

    // Handle calling synchronously
    if (!_.isFunction(callback)) {
        result = this.client().setSync(this.prefix + key, json_value, opts);
        this.log.silly("etcd set result:", result);
        if (result.err) throw result.err;
        if (this.cacheEnabled) this.cache[key] = value;
        return this;
    }

    // Handle async/callback
    this.client().set(this.prefix + key, json_value, opts,
            function (err, result) {
        if (err) return callback(err);
        this.log.silly("etcd set async result:", result);
        if (this.cacheEnabled) this.cache[key] = value;
        callback(null, value);
    }.bind(this));

    return this;
};


/**
 * Dump the current config as an object suitable for serialization to JSON.
 */
Config.prototype.dump = function dump () {
    var result = this.client().getSync(this.prefix, {recursive: true});
    var nodes;
    var obj = {};
    var ns = '/' + this.prefix;

    if (result.err) throw result.err;
    if (!result.body || !result.body.node || !result.body.node.nodes) {
        this.log.warn("etcd unknown result:", result);
        return;
    }

    nodes = result.body.node.nodes;
    for (var i=0; i < nodes.length; i++) {
        var key = nodes[i].key;
        var value = nodes[i].value;
        try {
            value = JSON.parse(value);
        }
        catch (err) {
        }
        if (_.startsWith(key, ns)) key = key.slice(ns.length);
        obj[key] = value;
    }
    return obj;
};


/**
 * Loads a jetconfig dump
 */
Config.prototype.load = function load (config) {
    return config;
};


/**
 * Clears all configuration stored in etcd
 */
Config.prototype.clear = function clear () {
    if (!this.allowClear)
        throw new Error("clear() is not allowed on this instance");

    var result = this.client().rmdirSync(this.prefix, {recursive: true});
    if (result.err) {
        if (result.err.errorCode === 100) return;
        throw result.err;
    }
    this.log.silly("etcd delete result:", result);

    // Handle a missing body (shouldn't happen?)
    if (!result.body) {
        this.log.warn("etcd unknown result:", result);
        return;
    }

    if (this.cacheEnabled) this.cache = {};

    this.log.debug(result.body.action, result.body.node.key);
};


/**
 * Return a configured Etcd instance ready for use.
 */
Config.prototype.client = function client () {
    // If we've already got a client, just return it
    if (this._client) return this._client;

    this._client = new Etcd(this.hosts, this.sslopts);
    return this._client;
};


/**
 * Private helper to parse the etcd result.
 */
Config.prototype._parseResult = function _parseResult (result) {
    var body;
    var value;
    // Check what errors we have
    if (result.err) {
        // errorCode 100 is a missing key, so we return undefined
        if (result.err.errorCode == 100) return;
        this.log.silly("etcd error result:", result);
        // Otherwise we throw the error so it can propagate up the stack
        throw result.err;
    }

    // Handle a missing body (shouldn't happen?)
    if (!result.body) {
        this.log.warn("etcd unknown result:", result);
        return;
    }

    // Handle a missing node (also shouldn't happen?)
    body = result.body;
    if (!body.node) {
        this.log.warn("etcd missing node:", body);
        return;
    }

    this.log.debug(body.action, body.node.key, body.node.value);

    // We always try to parse the value as JSON for convenience
    try {
        value = JSON.parse(body.node.value);
    }
    catch (err) {
        value = body.node.value;
    }

    return value;
};


/**
 * Private helper to set up the Config instnace
 *
 * @param hosts {String|Object} - Etcd hosts
 * @param opts {Object} - Config options
 */
var _getEnvHosts; // _getEnvHosts(hosts)
init = function init (hosts, opts) {
    var defaults = {
        cache: true,
        prefix: 'config/',
        logLevel: 'critical',
        allowClear: false,
    };
    if (_.isPlainObject(hosts)) {
        opts = hosts;
        hosts = undefined;
    }
    opts = opts || {};
    opts = _.defaults(opts, defaults);

    assert(_.isBoolean(opts.cache), "cache must be boolean");

    // Ensure prefix is a string without extra whitspace and ends with a slash
    assert(_.isString(opts.prefix), "prefix must be string");
    opts.prefix = _.trim(opts.prefix);
    opts.prefix = _.trim(opts.prefix, '/');
    opts.prefix += '/';

    // Ensure that the sslopts has the correct format
    if (opts.ssl) {
        assert(_.isPlainObject(opts.ssl), "ssl options must be object");
    }

    if (opts.cache) {
        this.cache = {};
    }

    this.cacheEnabled = opts.cache;
    this.prefix = opts.prefix;
    this.sslopts = opts.ssl;
    this.hosts = _getEnvHosts(hosts);
    this.allowClear = opts.allowClear;
    this.log = new Log();
    this.log.level(this.logLevel);

};


/**
 * Private helper for parsing the host options for the Config object.
 */
_getEnvHosts = function _getEnvHosts (hosts) {
    hosts = process.env.JETCONFIG_ETCD || hosts;

    if (hosts === undefined) hosts = ['127.0.0.1:2379'];
    if (_.isString(hosts)) hosts = hosts.split(',');

    assert(_.isArray(hosts), "hosts must be string or array");
    assert(_.reduce(_.map(hosts, _.isString)), "host must be string");

    hosts = _.map(hosts, _.trim);
    return hosts;
};


/**
 * Flatten an object into dot-notation keys
 */
Config.prototype._flatten = function(data) {
    var result = {};
    function recurse (cur, prop) {
        if (Object(cur) !== cur) {
            result[prop] = cur;
        } else if (Array.isArray(cur)) {
            for(var i=0, l=cur.length; i<l; i++)
                 recurse(cur[i], prop ? prop+"."+i : ""+i);
            if (l === 0)
                result[prop] = [];
        } else {
            var isEmpty = true;
            for (var p in cur) {
                isEmpty = false;
                recurse(cur[p], prop ? prop+"."+p : p);
            }
            if (isEmpty)
                result[prop] = {};
        }
    }
    recurse(data, "");
    return result;
};
