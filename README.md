# jetconfig
etcd based configuration for node.js

[![Build Status](https://travis-ci.org/shakefu/jetconfig.svg)](https://travis-ci.org/shakefu/jetconfig)

*jetconfig* has the following features:

* Namespace prefixes for configurations to allow individual apps or modules to
  operate using a single etcd cluster
* Synchronous and callbacks supported for most API methods
* In-process caching of configuration settings by default for best performance
* Cache-only operating mode for when etcd is not available
* Loading/dumping of entire configuration for backups or test configurations

## Installation

jetconfig is on [npmjs.org](https://www.npmjs.com/package/jetconfig).

```bash
$ npm install --save jetconfig
```

Make sure you have [etcd](http://coreos.com/docs/etcd) running otherwise
jetconfig isn't going to do you a lot of good.

## Getting started

Without any other parameters, jetconfig will try to connect to an etcd instance
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
    more information.
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

### `.dump()`

Returns an object suitable for JSON serialization which represents a dump of
the current configuration as defined in etcd.

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

### `.clear()`

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

## Changelog

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
