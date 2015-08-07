var Config = function Config () {

};

/**
 * Return a config value for `key`.
 *
 * @param key {string} - Dot notation key name
 * @param def - Default value if key is not found
 */
Config.prototype.get = function get (key, def) {
    return def;
};


module.exports = Config;

