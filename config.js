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
    var result;

    assert(_.isString(key), "key must be a String");

    if (_.isFunction(def)) {
        callback = def;
        def = undefined;
    }

    if (_.isFunction(opts)) {
        callback = opts;
        opts = undefined;
    }

    // Handle calling synchronously
    if (!callback) {
        result = this.client().getSync(this.prefix + key);
        this.log.silly("Get result:", result);
        result = this._parseResult(result);
        if (result === undefined) {
            // XXX Jake: Need to memoize this
            this.log.debug("Key not found:", key);
            return def;
        }
        return result;
    }

    // Handle async/callbck
    assert(_.isFunction(callback), "callback must be a Function");

    this.client().get(this.prefix + key, function (err, result) {
        result = {err: err, body: result};
        this.log.silly("Get result async:", result);
        try {
            result = this._parseResult(result); 
        }
        catch (err) {
            callback(err);
        }
        if (result === undefined){
            // XXX Jake: Memoize here
            return callback(null, def);
        }
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
    var result;
    var json_value;

    assert(_.isString(key), "key must be a String");

    if (!_.isString(value)) json_value = JSON.stringify(value);
    else json_value = value;

    this.log.debug('set', key, json_value);

    if (_.isFunction(opts)) {
        callback = opts;
        opts = undefined;
    }

    // Handle calling synchronously
    if (!_.isFunction(callback)) {
        result = this.client().setSync(this.prefix + key, json_value, opts);
        this.log.silly("Set result:", result);
        if (result.err) throw result.err;
        return this;
    }

    // Handle async/callback
    this.client().set(this.prefix + key, json_value, opts,
            function (err, result) {
        if (err) return callback(err);
        this.log.silly("Set result async:", result);
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
        this.log.warn("Unknown result:", result);
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
        this.log.silly("Error result:", result);
        // Otherwise we throw the error so it can propagate up the stack
        throw result.err;
    }

    // Handle a missing body (shouldn't happen?)
    if (!result.body) {
        this.log.warn("Unknown result:", result);
        return;
    }

    // Handle a missing node (also shouldn't happen?)
    body = result.body;
    if (!body.node) {
        this.log.warn("Missing node:", body);
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
 * Sets up the Config instnace
 *
 * @param hosts {String|Object} - Etcd hosts
 * @param opts {Object} - Config options
 */
var _getEnvHosts; // _getEnvHosts(hosts)
init = function init (hosts, opts) {
    var defaults = {
        prefix: 'config/',
        logLevel: 'critical'
    };
    if (_.isPlainObject(hosts)) {
        opts = hosts;
        hosts = undefined;
    }
    opts = opts || {};
    opts = _.defaults(opts, defaults);

    // Ensure prefix is a string without extra whitspace and ends with a slash
    assert(_.isString(opts.prefix), "prefix must be string");
    opts.prefix = _.trim(opts.prefix);
    opts.prefix = _.trim(opts.prefix, '/');
    opts.prefix += '/';

    // Ensure that the sslopts has the correct format
    if (opts.ssl){
        assert(_.isPlainObject(opts.ssl), "ssl options must be object");
    }

    this.prefix = opts.prefix;
    this.sslopts = opts.ssl;
    this.hosts = _getEnvHosts(hosts);
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


