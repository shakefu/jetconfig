var _ = require('lodash');
var assert = require('assert');



var Config = function Config () {
    assert(this instanceof Config, "Missing 'new' keyword");
};

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
    assert(_.isFunction(callback));
    callback(null, def);
};

exports.Config = Config;
