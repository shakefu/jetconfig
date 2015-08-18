var _ = require('lodash');
var assert = require('assert');

var Log = function Log (name) {
    assert(this instanceof Log, "Missing 'new' keyword");
    this.name = name;
    this._levels = {
        critical: 3,
        warn: 2,
        info: 1,
        debug: 0,
        silly: -1
    };
    _.assign(this._levels, _.invert(this._levels));
    var loglevel = process.env.JETCONFIG_LOGLEVEL || 3;
    if (!_.isNaN(Number(loglevel))) loglevel = Number(loglevel);
    if (loglevel && this._levels[loglevel] !== undefined){
        if (!_.isNumber(loglevel)) this._level = this._levels[loglevel];
        else this._level = loglevel;
    }
};
module.exports = Log;


/**
 * Change the active log level for this logger
 */
Log.prototype.level = function level (lev) {
    if (lev === undefined) return this._levels[this._level];
    if (this._levels[lev] === undefined) {
        throw new Error("Unknown log level '" + lev + "'");
    }

    this._level = this._levels[lev];
    return this;
};


/**
 * Log a message
 */
Log.prototype.log = function (msg, level) {
    level = level || 0;
    if (level < this._level) return;
    if (this._levels[level] === undefined) return;
    if (this.name) {
        msg = "[" + this.name + "] " + msg;
    }
    msg = this._levels[level].toUpperCase() + ' ' + msg;
    console.log(msg);
};


/**
 * Private helper for allowing log methods to take multiple arguments of
 * different types.
 */
var _formatLog = function _formatLog (args) { 
    var msg = '';
    for (var i=0; i<args.length; i++) {
        var arg = args[i];
        if (i > 0) msg += ' ';
        if (_.isString(arg)) {
            msg += arg;
            continue;
        }
        try {
            msg += JSON.stringify(arg, null, 2);
            continue;
        } catch (err) {}
        try {
            msg += arg.toString();
            continue;
        } catch (err) {}
        try {
            msg += String(arg);
            continue;
        } catch (err) {}
        try {
            msg += '' + arg;
            continue;
        } catch (err) {}
        msg += "[Object]";
    }
    return msg;
};


/**
 * Log level shortcuts
 */
Log.prototype.silly = function () {
    this.log(_formatLog(_.toArray(arguments)), -1);
    return this;
};
Log.prototype.debug = function () {
    this.log(_formatLog(_.toArray(arguments)), 0);
    return this;
};
Log.prototype.info = function () {
    this.log(_formatLog(_.toArray(arguments)), 1);
    return this;
};
Log.prototype.warn = function () {
    this.log(_formatLog(_.toArray(arguments)), 2);
    return this;
};
Log.prototype.critical = function () {
    this.log(_formatLog(_.toArray(arguments)), 3);
    return this;
};
