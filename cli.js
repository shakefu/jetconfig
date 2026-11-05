#!/usr/bin/env node
var path = require('path');
var Config = require('./index.js');
var parseArgs = require('minimist');

var log_levels = ['silly', 'debug', 'info', 'warn', 'critical'];
var log_level = 4;

var script = path.basename(process.argv[1]);

var commands; // Command definitions, assigned below.

// The global options. The `help` strings are what nomnom printed, and the
// usage generators below reproduce nomnom's help layout.
var global_options = [
    {
        name: "version",
        help: "Print version and exit"
    },
    {
        name: "noInherit",
        abbr: "n",
        full: "no-inherit",
        help: "Prevent configuration inheritance"
    },
    {
        name: "verbose",
        abbr: "v",
        help: "Increase verbosity, can be used multiple times"
    }
];

var pad = function pad (str, width) {
    while (str.length < width) str += " ";
    return str;
};

var option_labels = function option_labels () {
    return global_options.map(function (opt) {
        var label = opt.abbr ? "-" + opt.abbr + ", " : "";
        return label + "--" + (opt.full || opt.name);
    });
};

var options_help = function options_help (lines) {
    var labels = option_labels();
    var width = Math.max.apply(null, labels.map(function (label) {
        return label.length;
    })) + 3;

    lines.push("Options:");
    global_options.forEach(function (opt, i) {
        lines.push("   " + pad(labels[i], width) + opt.help);
    });
};

var usage = function usage () {
    var lines = [""];
    var names = Object.keys(commands);
    var width = Math.max.apply(null, names.map(function (name) {
        return name.length;
    })) + 5;

    lines.push("Usage: " + script + " <command> [options]");
    lines.push("");
    lines.push(pad("command", width + 2));
    names.forEach(function (name) {
        lines.push("  " + pad(name, width) + commands[name].help);
    });
    lines.push("");
    options_help(lines);
    lines.push("");
    return lines.join("\n");
};

var command_usage = function command_usage (name) {
    var command = commands[name];
    var lines = [""];
    var optnames = Object.keys(command.options);
    var args = optnames.map(function (optname) {
        var required = command.options[optname].required;
        return required ? "<" + optname + ">" : "[" + optname + "]";
    });
    var width = Math.max.apply(null, optnames.map(function (optname) {
        return optname.length;
    })) + 5;

    lines.push("Usage: " + script + " " + name + " " + args.join(" ") +
        " [options]");
    lines.push("");
    optnames.forEach(function (optname) {
        lines.push(pad(optname, width) + command.options[optname].help);
    });
    lines.push("");
    options_help(lines);
    lines.push("");
    lines.push(command.help);
    return lines.join("\n");
};

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

commands = {
    dump: {
        help: "Dump the current etcd configuration",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace (default: config/)",
                default: "config/",
                required: true
            }
        },
        callback: cmd(function (conf) {
            return conf.dump();
        })
    },
    list: {
        help: "List all available etcd configurations",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace (default: /)",
                default: "/",
                required: true
            }
        },
        callback: cmd(function (conf) {
            return conf.list(undefined, {dirOnly: false});
        })
    },
    clear: {
        help: "Clear the current etcd configuration",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace",
                required: true
            },
            extra: {
                position: 2,
                help: "Don't forget to include a / between env and key",
                required: false,
            }
        },
        callback: cmd(function (conf, params) {
            if (params.extra) return {error: "You forgot a slash didn't you?"};
            conf.allowClear = true;
            conf.clear();
        })
    },
    load: {
        help: "Load a configuration from a file",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace",
                required: true
            },
            file: {
                position: 2,
                help: "Filename to load",
                required: true,
            }
        },
        callback: cmd(function (conf, params) {
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
        })
    },
    get: {
        help: "Get a configuration key",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace",
                required: true
            },
            key: {
                position: 2,
                help: "Configuration key",
                required: true
            }
        },
        callback: cmd(function (conf, params) {
            var value = conf.get(params.key, params.value);
            if (value === undefined) process.exit(1);
            return value;
        })
    },
    set: {
        help: "Set a configuration key to a value",
        options: {
            prefix: {
                position: 1,
                help: "Etcd namespace",
                required: true
            },
            key: {
                position: 2,
                help: "Configuration key",
                required: true
            },
            value: {
                position: 3,
                help: "Configuration value",
                required: true
            }
        },
        callback: cmd(function (conf, params) {
            conf.set(params.key, params.value);
        })
    }
};

var args = process.argv.slice(2);
var ddash = args.indexOf("--");
var head = ddash === -1 ? args : args.slice(0, ddash);
var tail = ddash === -1 ? [] : args.slice(ddash);

// minimist turns `--no-foo` into `foo: false` instead of setting a
// `no-foo` flag, so normalize the long spellings of the `-n` option to the
// short form before parsing. Anything after `--` is left untouched.
head = head.map(function (arg) {
    if (arg === "--no-inherit" || arg === "--noInherit") return "-n";
    return arg;
});

// minimist does not accumulate repeated boolean flags, but `-v` is meant
// to be usable multiple times, so count occurrences ourselves.
var verbosity = head.filter(function (arg) {
    return arg === "-v" || arg === "--verbose";
}).length;
while (verbosity-- > 0 && log_level > 0) log_level -= 1;

var argv = parseArgs(head.concat(tail), {
    string: ["_"],
    boolean: ["version", "help", "h", "n"]
});

var name = argv._[0];
var command = commands[name];

if (command === undefined) {
    if (name !== undefined) {
        console.log(script + ": no such command '" + name + "'");
        return process.exit(1);
    }
    if (argv.help || argv.h) {
        console.log(usage());
        return process.exit(0);
    }
    if (argv.version) {
        console.log(require('./package').version);
    }
    console.log("\ncommand argument is required\n" + usage());
    return process.exit(1);
}

if (argv.help || argv.h) {
    console.log(command_usage(name));
    return process.exit(0);
}

var params = {};
var positionals = argv._.slice(1);

Object.keys(command.options).forEach(function (optname) {
    var opt = command.options[optname];
    var value = positionals[opt.position - 1];

    if (value === undefined && opt.default !== undefined) {
        value = opt.default;
    }
    if (value === undefined && opt.required) {
        console.log("\n" + optname + " argument is required\n" +
            command_usage(name));
        process.exit(1);
    }
    params[optname] = value;
});

if (argv.version) {
    console.log(require('./package').version);
}

params.noInherit = argv.n === true;

command.callback(params);
