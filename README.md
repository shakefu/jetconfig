# jetconfig
etcd based configuration for node.js

[![Build Status](https://travis-ci.org/shakefu/jetconfig.svg)](https://travis-ci.org/shakefu/jetconfig)

*jetconfig* has the following features:

* Namespace prefixes for configurations to allow individual apps or modules to
  operate using a single etcd cluster
* Configuration inheritance
* Synchronous and callbacks supported for most API methods
* In-process caching of configuration settings by default for best performance
* File-based caching of configuration for faster performance when up-to-date
  configuration is not required
* Cache-only operating mode for better performance
* Loading/dumping of entire configuration for backups or test configurations

Coming soon:

* Easy encryption for `jetconfig dump`

## Installation

jetconfig is on [npmjs.org](https://www.npmjs.com/package/jetconfig).

```bash
$ npm install --save jetconfig
```

Make sure you have [etcd](http://coreos.com/docs/etcd) running otherwise
jetconfig isn't going to do you a lot of good.

## Getting started

Without any other options, jetconfig will try to connect to an etcd instance
running on `127.0.0.1:2379` and use a namespace prefix of `config/`.

```javascript
var Config = require('jetconfig');

var conf = new Config();

// Load and locally cache the existing configuration from etcd
conf.load();

// Get a value from etcd
var my_setting = conf.get('app.setting');

// Get a value from etcd, but use the default if it doesn't exist
var defaults_allowed = conf.get('app.someSetting', 'default value');

// Write a new value to etcd
conf.set('some.setting.here', 'new value');

```

## Command Line Interface

See `jetconfig --help`.

If you don't have `./node_modules/.bin` on your `$PATH` you may want to install
the jetconfig module globally to make the command available.

```
$ jetconfig -h

Usage: jetconfig <command> [options]

command
  dump      Dump the current etcd configuration
  list      List all available etcd configurations
  clear     Clear the current etcd configuration
  load      Load a configuration from a file
  get       Get a configuration key
  set       Set a configuration key to a value

Options:
   --version       Print version and exit
   -n, --no-inherit   Prevent configuration inheritance
   -v, --verbose   Increase verbosity, can be used multiple times
```

## Environment Variables

When connecting to non-default hosts and ports using the CLI or for convenience
when using the API, you can configure *jetconfig* to connect using environment
variables.

The following variables are available:

* **`JETCONFIG_ETCD`** - Comma separated list of members in the etcd cluster,
  like `"10.0.0.1:2379,10.0.0.2:2379,10.0.0.3:2379"`
* **`JETCONFIG_SSL_CA`** - SSL CA certificate file if your etcd SSL setup uses
  a nonstandard root or intermediary
* **`JETCONFIG_SSL_CERT`** - SSL client certificate file
* **`JETCONFIG_SSL_KEY`** - SSL client key file
* **`JETCONFIG_LOGLEVEL`** - Set the log level for the jetconfig module
  (default: `'critical'`). Must be one of `'silly'`, `'debug'`, `'info'`,
  `'warn'` or `'critical'`.
* **`JETCONFIG_CACHE`** - Directory in which to store filesystem cache used in
  lieu of making requests to etcd... not recommend for production deployments
  where you want all your settings to stay up to date all time, but helpful in
  development when you have to restart your process often and the etcd
  roundtrip is too much overhead.
* **`JETCONFIG_PREFIX`** (Not Implemented) - Prefix for the configuration in
  etcd

**Example:**

Here's an example using the *jetconfig* CLI to connect to a production cluster.

```bash
$ export JETCONFIG_ETCD="10.0.0.101:2379,10.0.0.102:2379,10.0.0.103:2379"
$ export JETCONFIG_SSL_CA="/home/core/etcd/ca.crt"
$ export JETCONFIG_SSL_CERT="/home/core/etcd/client.crt"
$ export JETCONFIG_SSL_KEY="/home/core/etcd/client.key"
$ jetconfig dump /config
{
  "jetconfig.version": "1.2.1"
}
```

## Inheritance

One of the major features of *jetconfig* is the ability to inherit
configurations. This allows you to create child configurations that may only
alter one or two values from a parent configuration without having to copy and
maintain the entire group of settings.

##### Constructor-based inheritance

Inheritance is triggered in one of two ways, first, you can pass a string name
to the `inherit` option when creating an new `Config` instance. Below is an
example of this constructor-based inheritance:

```javascript
var parent = Config({
        prefix: 'config/parent',
    });

var child = Config({
        prefix: 'config/child',
        inherit: 'config/parent',
    });

// This is the base configuration, and it is inherited by the child
parent.load({
    'shared.key': true,
    'some.key': 'from parent'
});

// This is the more specific configuration and it uses values from the parent
// if it doesn't have the key defined itself, like the 'shared.key'
child.load({
    'some.key': 'from child'
});

child.get('shared.key'); // === true
child.get('some.key'); // === 'from child'
```

##### Key-based inheritance

The second way to trigger inheritance is to use a special key within the
configuration itself to specify the parent. By default, this will be
`'config.inherit'` but it can be changed with the `inheritKey` option to the
`Config()` constructor.

Here is how to key-based inheritance, continuing the example from above:

```javascript
var conf = Config({
        prefix: 'config/other'
    });

// By default, `inheritKey` will be 'config.inherit'
conf.load({
    'extra.key': 'inheritance, yey!',
    'config.inherit': 'config/child'
});

// If we set the inherit key on the `child` as well, we enable deep inheritance
child.set(conf.inheritKey, 'config/parent');

conf.get('shared.key') // === true
conf.get('some.key') // === 'from child'
conf.get('extra.key') // === 'inheritance, yey!'
```

Only the key-based inheritance allows for deep inheritance, and by default, the
max `inheritDepth` is set to 2, meaning a child configuration will only look as
far back as its grandparent to find a value for a given key. This may be set
arbitrarily high, but at some point will incur a fair amount of overhead.

## File-based caching

Jetconfig can use the filesystem to speed up loading of the configuration.

If jetconfig is using file-based caching, and the cache exists, it will not
read from etcd unless necessary (e.g. it does not have a cached copy of a key).

The file-based cache is read from when the `.load()` method is called.

**Note:** If you do not delete the `.json` file used for the cache, the
configuration will never be updated to reflect new settings in etcd. Cache
invalidation is hard. A future version of jetconfig may include automatic
invalidation.

TODO: Example and use cases.

## API Documentation

### `new Config(`*`[hosts], [options]`*`)`

Create a new jetconfig instance.

* **`hosts`** (*Array|String*) - A host or list of hosts to use for the etcd
  cluster. This may be a single host as a string, an array of host strings, or
  a string of comma-separated hosts. (default: `'127.0.0.1:2379'`)
  If `JETCONFIG_ETCD` is set in the Env, it will override whatever is passed
  here.
* **`options`** (*Object*) - Options object (optional)
  * **`cache`** (*Boolean*) - Whether to allow local caching to speed up
    performance (default: `true`). It's highly recommended that you leave this
    enabled, unless you specifically need realtime queries of etcd. Etcd is not
    super duper fast, so if you're using a lot of configuration keys in your
    application, disabling this cache could cause your application to grind to
    a halt.
  * **`prefix`** (*String*) - Namespace prefix for etcd (default: `'config/'`)
  * **`ssl`** (*Object*) - SSL options for etcd. See the [node-etcd SSL
    documentation](https://github.com/stianeikeland/node-etcd#ssl-support) for
    more information. These are not filenames, but the actual files already
    loaded.
    * **`ca`** - Certificate Authority
    * **`cert`** - Client certificate
    * **`key`** - Client key
  * **`logLevel`** (*String*) - Log level to use for this config instance
    (default: `'critical'`)
  * **`allowClear`** (*Boolean*) - Whether to allow the `.clear()` method on
    this instance (default: `false`)
  * **`caseSensitive`** (*Boolean*) - Whether to allow case sensitive keys
    (default: `false`). This will coerce keys to lower case for storage in
    etcd, so if you need case sensitivity to avoid key conflicts, enable it.
  * **`inherit`** (*String|Boolean*) - Whether to allow inheritance, or the key
    name to inherit from. (default: `true`)
  * **`inheritDepth`** (*Number*) - The maximum depth to check inherited
    configurations for missing keys (default: `1`)
  * **`inheritKey`** (*String*) - The configuration key name used to store the
    inherited configuration key (default: `'config.inherit'`)
  * **`fileCache`** (*String*) - Directory to use for filesystem cache.
    *jetconfig* will attempt to create this directory if it doesn't exist.
  * **`watch`** (*Boolean*) - Whether to watch for changes to the etcd
    configuration and update the cached configuration when changes happen
    (default: `false`) *New in 1.4.0.*

### `.get(key, `*`[def], [options], [callback]`*`)`

Get the current value for `key`.

If called synchronously, this method may throw exceptions if there are
underlying client errors.

* **`key`** (*String*) - Key name to retrieve
* **`def`** - Default value (optional)
* **`options`** (*Object*) - Options for this call (optional)
  * **`cached`** (*Boolean*) - Whether to use the configuration cache (default:
    `true`)
  * **`cacheResult`** (*Boolean*) - Whether to store the result in the cache
    (default: `true`)
  * **`cacheOnly`** (*Boolean*) - Whether to only use the cache and not query
    etcd if the cache doesn't have a value (default: `false`)
  * **`allowInherited`** (*Boolean*) - Whether to allow querying of inherited
    configurations (default: `true`)
* **`callback`** (*Function=*) - Callback (optional). If omitted, this method
  will return the value synchronously.

### `.set(key, value, `*`[options], [callback]`*`)`

Sets a value and writes it to etcd.

If called synchronously, this method may throw exceptions if there are
underlying client errors.

* **`key`** (*String*) - Key name to set
* **`value`** - Value to set
* **`options`** (*Object*) - Options for this call (optional)
  * **`cacheOnly`** (*Boolean*) - Whether to only write to the local cache and
    not etcd (default: `false`). If *cacheOnly* is *true* and the config
    instance does not have caching enabled, this will not set the value
    anywhere.
* **`callback`** (*Function=*) - Callback (optional)

### `.dump(`*`[options]`*`)`

Returns an object suitable for JSON serialization which represents a dump of
the current configuration as defined in etcd.

* **`options`** (*Object*) - Options for this call (optional)
  * **`allowInherited`** (*Boolean*) - Whether to allow inherited
    configurations (default: `true`)

### `.load(`*`[config], [options]`*`)`

Load the current configuration in etcd into the local cache.

If *config* is specified, it loads a configuration file, JSON string, or
JavaScript object into a configuration instance.

By default, the configuration is not written to etcd, and only loaded into the
configuration cache. Pass the option `cacheOnly: false` if you wish to write
the loaded configuration to etcd as well.

If *load* is called multiple times, by default, the subsequent loads will be
merged into the configuration cache. Specify the option `merge: false` if you
want to instead clear the cache first.

If this *Config* has a *fileCache* enabled, calling *load* will read that file,
if it exists, in lieu of reading the configuration from etcd.

When writing to etcd, the configuration will always be merged into the existing
etcd configuration, instead of being overwritten. If you wish to overwrite the
existing configuration, use `.clear()` first.

* **`config`** (*String|Object*) - Configuration filename, JSON string, or
  Object to load (optional)
* **`options`** (*Object*) - Options for loading the configuration
  * **`cacheOnly`** (*Boolean*) - Whether to only load it into cache or to
    write the loaded configuration to etcd (default: `true`)
  * **`merge`** (*Boolean*) - Whether to merge the existing cache with the
    newly loaded config, or clear it first
  * **`allowInherited`** (*Boolean*) - Whether to allow inherited
    configurations (default: `true`)

### `.list(`*`[key], [options]`*`)`

List all etcd directories under the config prefix and *key*. If *key* is
omitted, all directories under *prefix* are listed.

* **`key`** (*String*) - Key to list (optional)
* **`options`** (*Object*) - Options
  * **`dirOnly`** (*Boolean*) - List only directories (default: `true`)

### `.clear(`*`[options]`*`)`

Clears all the stored keys for the given config object in etcd. This must be
explicitly enabled by passing the `allowClear: true` option to the constructor.

* **`options`** (*Object*) - Additional options for clearing
  * **`cacheOnly`** (*Boolean*) - Whether to only clear the configuration cache
    (default: `false`)

### `.log.level(`*`[level]`*`)`

Set or get the current log level for the this instance.

Log level may be one of `'silly'`, `'debug'`, `'info'`, `'warn'`, or
`'critical'`. The default is `'critical'`.

This may also be set with the environment variable `JETCONFIG_LOGLEVEL=debug`.

* **`level`** (*String*) - Sets the log level. If this is omitted, the current
  level is returned as a string.

### `.client()`

Return a reference to the underlying *node-etcd* client instance.

### `.close()`

Stop watchers. Does not attempt to close other TCP connections.

## Changelog

* **1.4.0** - Add watch option and ability to update cached configuration when
  etcd changes. Also add close() method to ensure watchers are stopped.

  Going forward this repository will also use `npm version` tags, which include
  the leading `v` in the tag on GitHub.

  *Released June 2, 2016.*

* **1.3.7** - Fix bug where cacheOnly .get() calls would not return the
  supplied default value.

  *Released January 8, 2016.*

* **1.3.3** - Update README

* **1.3.1** - Better error handling

* **1.3.0** - Adds filesystem caching capabilities.

  *Released September 10, 2015.*

* **1.2.3** - Minor typo fix, and set the default `inheritDepth` to 2.

  *Released September 1, 2015.*

* **1.2.2**
  - Add `dirOnly` option to `.list()`
  - Add `-no-inherit` option to CLI

  *Released August 24, 2015.*

* **1.2.1** - Change default inheritance key to `'config.inherit'`.

* **1.2.0** - Add `.list()` and command line utility.

* **1.1.0** - Added configuration inheritance, other minor refactors and clean
  ups.

  *Released August 14, 2015.*

* **1.0.0** - Initital release

  *Released August 12, 2015.*

## License

Copyright 2015 Jacob Alheid

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
