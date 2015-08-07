var _ = require('lodash');
var assert = require('assert');


/**
 * Create a new config instance backed by etcd
 */
var Config = function Config (hosts, opts) {
    assert(this instanceof Config, "Missing 'new' keyword");
    this.init(hosts, opts);
};
exports.Config = Config;

/**
 * Return a config value for `key`.
 *
 * @param key {string} - Dot notation key name
 * @param def - Default value if key is not found
 */
Config.prototype.get = function get (key, def, callback) {
    if (!callback) {
        return def;
    }
    assert(_.isFunction(callback), "callback must be a function");
    callback(null, def);
};


var _getEnvHosts = function _getEnvHosts (hosts) {
    hosts = process.env.JETCONFIG_ETCD || hosts;
    
    if (hosts === undefined) hosts = ['127.0.0.1:2379'];
    if (_.isString(hosts)) hosts = hosts.split(',');

    assert(_.isArray(hosts), "hosts must be string or array");
    assert(_.reduce(_.map(hosts, _.isString)), "host must be string");
    
    hosts = _.map(hosts, _.trim);
    return hosts;
};

/**
 * Sets up the Config instnace
 */
Config.prototype.init = function init (hosts, opts) {
    var defaults = {
        prefix: 'config/',
        ssl: {}
    };
    if (_.isPlainObject(hosts)) {
        opts = hosts;
        hosts = undefined;
    }
    opts = opts || {};
    opts = _.defaults(opts, defaults);

    assert(_.isString(opts.prefix), "prefix must be string");
    assert(_.isPlainObject(opts.ssl), "ssl options must be object");

    this.prefix = opts.prefix;
    this.sslopts = opts.ssl;

    this.hosts = _getEnvHosts(hosts);
};
