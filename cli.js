#!/usr/bin/env node
var path = require('path');
var Config = require('./index.js');

var parser = require('nomnom');
var log_levels = ['silly', 'debug', 'info', 'warn', 'critical'];
var log_level = 4;

parser.script('jetconfig');

parser.option('version', {
        flag: true,
        help: "Print version and exit",
        callback: function () { console.log(require('./package').version); }
    })
    .option('noInherit', {
        flag: true,
        help: "Prevent configuration inheritance",
        abbr: 'n',
        full: 'no-inherit',
    })
    .option('verbose', {
        abbr: 'v',
        help: "Increase verbosity, can be used multiple times",
        flag: true,
        callback: function () {
            if (log_level > 0) log_level -= 1;
        }
    });

var cmd = function cmd (func) {
    var handler = function handler (params) {
        var opts = {};
        var conf;
        var result;

        opts.logLevel = log_levels[log_level];
        opts.prefix = params.prefix;
        opts.inherit = !params.noInherit;

        conf = new Config(opts);
        result = func(conf, params);
        if (result !== undefined) console.log(JSON.stringify(result, null, 2));
    };
    return handler;
};

parser.command('dump')
    .help("Dump the current etcd configuration")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace (default: config/)',
        default: 'config/',
        required: true
    })
    .callback(cmd(function (conf) {
        return conf.dump();
    }));

parser.command('list')
    .help("List all available etcd configurations")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace (default: /)',
        default: '/',
        required: true
    })
    .callback(cmd(function (conf) {
        return conf.list(undefined, {dirOnly: false});
    }));

parser.command('clear')
    .help("Clear the current etcd configuration")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace',
        required: true
    })
    .callback(cmd(function (conf) {
        conf.allowClear = true;
        conf.clear();
    }));

parser.command('load')
    .help("Load a configuration from a file")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace',
        required: true
    })
    .option('file', {
        position: 2,
        help: 'Filename to load',
        required: true,
    })
    .callback(cmd(function (conf, params) {
        var filename = path.resolve(params.file);
        var new_conf;
        try {
            new_conf = require(filename);
        } catch (err) {
            if (String(err).match(/Cannot find module/)) {
                console.log("No such file:", params.file);
            }
            else {
                console.log('' + err);
            }
            return process.exit(1);
        }
        conf.log.silly("Read config", new_conf);
        conf.load(new_conf, {cacheOnly: false});
    }));

parser.command('get')
    .help("Get a configuration key")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace',
        required: true
    })
    .option('key', {
        position: 2,
        help: 'Configuration key',
        required: true
    })
    .callback(cmd(function (conf, params) {
        value = conf.get(params.key, params.value);
        if (value === undefined) process.exit(1);
        return value;
    }));

parser.command('set')
    .help("Set a configuration key to a value")
    .option('prefix', {
        position: 1,
        help: 'Etcd namespace',
        required: true
    })
    .option('key', {
        position: 2,
        help: 'Configuration key',
        required: true
    })
    .option('value', {
        position: 3,
        help: 'Configuration value',
        required: true
    })
    .callback(cmd(function (conf, params) {
        conf.set(params.key, params.value);
    }));

parser.parse();
