# jetconfig
etcd based configuration for node.js

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

### `new Config([hosts], [options])`

Create a new jetconfig instance.

* `hosts` (*Array|string*) - A host or list of hosts to use for the etcd
  cluster. This may be a single host as a string, an array of host strings, or
  a string of comma-separated hosts. (default: `'127.0.0.1:2379'`)

  If `JETCONFIG_ETCD` is set in the Env, it will override whatever is passed
  here. 
* `options` (*Object*) - Options object (optional)

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
