# jetconfig
etcd based configuration for node.js

[![Build Status](https://travis-ci.org/shakefu/jetconfig.svg)](https://travis-ci.org/shakefu/jetconfig)

## Installation

jetconfig is on [npmjs.org].

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
```

## API Documentation

#### `new Config(`*`[hosts], [options]`*`)`

Create a new jetconfig instance.

* **`hosts`** (*Array|String*) - A host or list of hosts to use for the etcd
  cluster. This may be a single host as a string, an array of host strings, or
  a string of comma-separated hosts. (default: `'127.0.0.1:2379'`)

  If `JETCONFIG_ETCD` is set in the Env, it will override whatever is passed
  here. 
* **`options`** (*Object*) - Options object (optional)
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

#### `.get(key, `*`[def], [options], [callback]`*`)`

* **`key`** (*String*) - Key name to retrieve
* **`def`** - Default value (optional)
* **`options`** (*Object*) - Options to provide to etcd client (optional)
* **`callback`** (*Function=*) - Callback (optional)

Get the current value for `key`.

#### `.set(key, value, `*`[options], [callback]`*`)`

Sets a value and writes it to etcd.

* **`key`** (*String*) - Key name to set
* **`value`** - Value to set
* **`options`** (*Object*) - Options to provide to etcd client (optional)
* **`callback`** (*Function=*) - Callback (optional)

#### `.dump()`

Returns an object suitable for JSON serialization which represents a dump of
the current configuration.

#### `.clear()`

Clears all the stored keys for the given config object in etcd. This must be
explicitly enabled by passing the `allowClear: true` option to the constructor.

#### `.log.level(`*`[level]`*`)`

Set or get the current log level for the this instance.

This may also be set with the environment variable `JETCONFIG_LOGLEVEL=debug`.

* **`level`** (*String*) - Sets the log level. If this is omitted, the current
  level is returned as a string.

#### `.client()`

Return a reference to the underlying *node-etcd* client instance.


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
