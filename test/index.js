/* jshint expr:true */
var _ = require('lodash');
var pkg = require('../package.json');
var Etcd = require('node-etcd');
var chai = require('chai');
var expect = chai.expect;
chai.should();
// var should = chai.should();

var Config = require('../index.js');


before(function (done) {
    var hosts = process.env.JETCONFIG_ETCD;
    var etcd = new Etcd(hosts);
    var key = 'jetconfig/test/version';
    etcd.setSync(key, pkg.version, {ttl: 1});
    var res = etcd.getSync(key);
    if (!res || !res.body || !res.body.node ||
        res.body.node.value !== pkg.version ){
        return done(new Error("etcd not working properly, aborting tests"));
    }
    // Uncomment this to get helpful debug logging for all the tests
    // process.env.JETCONFIG_LOGLEVEL = 'silly';
    done();
});


after(function () { 
    var conf = new Config({prefix: 'jetconfig/', allowClear: true});
    try {
        conf.clear();
    }
    catch (err) {
        conf.warn("Error clearing test configs", err);
    }
});


describe("Config", function () {
    describe("new", function () {
        var host1 = '127.0.0.1:4001';
        var host2 = '127.0.0.1:2379';

        it("should be required", function () {
            expect(Config).to.throw("AssertionError: Missing 'new' keyword");
        });

        it("should provide a default host", function () {
            var conf = new Config();
            conf.hosts.should.eql([host2]);
        });

        it("should allow for env-based hosts", function () {
            // Save the env for later
            var env = process.env.JETCONFIG_ETCD;
            process.env.JETCONFIG_ETCD = host2;
            var conf = new Config();
            conf.hosts.should.eql([host2]);
            // Restore the env
            if (env === undefined) delete process.env.JETCONFIG_ETCD;
            else process.env.JETCONFIG_ETCD = env;
        });

        it("should allow for a single string host", function () {
            var conf = new Config(host2);
            conf.hosts.should.eql([host2]);
        });

        it("should allow for array hosts", function () {
            var conf = new Config([host1, host2]);
            conf.hosts.should.eql([host1, host2]);
        });

        it("should throw for other data types", function () {
            expect(function (){ new Config(1) }).to.throw( // jshint ignore:line
                "AssertionError: hosts must be string or array");
        });

        it("should throw if host in array isnt string",  function () {
            expect(function (){ new Config([1]); }) // jshint ignore:line
                .to.throw("AssertionError: host must be string");
        });

        it("should allow for multiple hosts separated by comma", function () {
            var conf = new Config(host1 + ',' + host2);
            conf.hosts.should.eql([host1, host2]);
        });

        it("should trim comma separated hosts", function () {
            var conf = new Config(host1 + ', ' + host2);
            conf.hosts.should.eql([host1, host2]);
        });

        it("should trim prefixes", function () {
            var conf = new Config({prefix: ' jetconfig/foo/ '});
            conf.prefix.should.equal('jetconfig/foo/');
        });

        it("should add a trailing slash to a prefix", function () {
            var conf = new Config({prefix: 'jetconfig/foo'});
            conf.prefix.should.equal('jetconfig/foo/');
        });

        it("should trim leading slashes on the prefix", function () {
            var conf = new Config({prefix: '/jetconfig/bar'});
            conf.prefix.should.equal('jetconfig/bar/');
        });

        it("should require cache option to be boolean", function () {
            expect(function () { new Config({cache: 'foo'}); }) // jshint ignore:line
                .to.throw("cache must be boolean");
        });

        it("should require caseSensitive option to be boolean", function () {
            expect(function () { new Config({caseSensitive: 'foo'}); }) // jshint ignore:line
                .to.throw("caseSensitive must be boolean");
        });
    });

    describe('#get()', function (){
        var conf;

        before(function (){
            conf = new Config();
        });

        it("should return a default value", function () {
            conf.get('foo', true).should.equal(true);
        });

        it("should return an existing value", function () {
            conf.set('existing', {value: 1}, {ttl: 1});
            var res = conf.get('existing');
            expect(res).to.not.be.undefined;
            res.should.eql({value: 1});
        });

        it("should work with a callback and default value", function (done) {
            conf.get('foo', true, function (err, val) {
                if (err) return done(err);
                expect(val).to.not.be.null;
                val.should.equal(true);
                done();
            });
        });

        it("should work a callback and existing value", function (done) {
            conf.get('existing', function (err, val) {
                if (err) return done(err);
                expect(val).to.not.be.undefined;
                val.should.eql({value: 1});
                done();
            });
        });

        it("should have a case insensitive cache for defaults", function () {
            conf.get('caseSensitive', true).should.equal(true);
            conf.get('casesensitive').should.equal(true);
        });

        it("should respect the caseSensitive option", function () {
            var case_conf = new Config({caseSensitive: true});
            case_conf.get('caseSensitive', true).should.equal(true);
            expect(case_conf.get('casesensitive')).to.be.undefined;
        });
    });

    describe('#set()', function () {
        var conf;

        before(function (){
            conf = new Config({
                cache: false,
                allowClear: true,
            });
            conf.clear();
        });

        after(function () {
            conf.clear();
        });

        it("should work with a callback", function (done) {
            conf.set('set_callback', true, function (err, value) {
                if (err) return done(err);
                expect(value).to.not.be.undefined;
                value.should.equal(true);
                conf.get('set_callback', function (err, value) {
                    if (err) return done(err);
                    expect(value).to.not.be.undefined;
                    value.should.equal(true);
                    done();
                });
            });
        });

        it("should work for a string", function () {
            conf.set('string', 'a');
            conf.get('string').should.equal('a');
        });

        it("should work for a number", function () {
            conf.set('number', 32);
            conf.get('number').should.equal(32);
        });

        it("should work for a float", function () {
            conf.set('float', 5.5);
            conf.get('float').should.equal(5.5);
        });

        it("should work for a object", function () {
            conf.set('object', {'foo': 'bar'});
            conf.get('object').should.eql({'foo': 'bar'});
        });

        it("should work for a bool", function () {
            conf.set('bool', false);
            conf.get('bool').should.equal(false);
        });

        it("should work for a array", function () {
            conf.set('array', ['a', 2, false]);
            conf.get('array').should.eql(['a', 2, false]);
        });

        it("should set and retrieve cache-only values", function () {
            var cache_conf = new Config();
            cache_conf.set('test-cache-only', 'cached', {cacheOnly: true});
            cache_conf.get('test-cache-only').should.equal('cached');
        });

        it("should not set cache-only values if cache is off", function () {
            conf.set('test-cache-off', 'cached', {cacheOnly: true});
            expect(conf.get('test-cache-off')).to.be.undefined;
        });

        it("should be case insensitive by default", function () {
            conf.set('setCaseSensitive', 'Value');
            conf.clear({cacheOnly: true});
            expect(conf.get('setCasesensitive')).to.not.be.undefined;
            conf.get('setcasesensitive').should.equal('Value');
        });

        it("should respect case sensitivity", function () {
            var case_conf = new Config({
                prefix: 'jetconfig/test/case_sensitive',
                caseSensitive: true,
                allowClear: true
            });

            case_conf.set('caseSensitive', 'Value');
            case_conf.clear({cacheOnly: true});
            expect(conf.get('casesensitive')).to.be.undefined;
        });
    });

    describe('#dump()', function () {
        var conf;

        before(function () {
            conf = new Config({prefix: 'jetconfig/dump'});
            conf.set('ph.alpha', 'a');
            conf.set('ph.beta', 'b');
            conf.set('ph.obj', {'o': 1});
        });

        it("should work", function () {
            var dump = conf.dump();
            expect(dump).to.not.be.undefined;
            dump.should.eql({
                'ph.alpha': 'a',
                'ph.beta': 'b',
                'ph.obj': {'o': 1}
            });
        });

        it("should be case insensitive by default", function () {
            var conf = new Config({prefix: 'jetconfig/dump/case'});
            conf.set('some.Key.Here', 'Value');
            var dump = conf.dump();
            expect(dump).to.not.be.undefined;
            dump.should.eql({'some.key.here': 'Value'});
        });

        it("should respect case sensitivity", function () {
            var case_conf = new Config({
                prefix: 'jetconfig/test/caseDump',
                caseSensitive: true,
            });
            case_conf.set('someKey', 'Value');
            var dump = case_conf.dump();
            expect(dump).to.not.be.undefined;
            dump.should.eql({someKey: 'Value'});
        });
    });

    describe('#load()', function () {
        var conf;

        before(function () {
            conf = new Config({
                prefix: 'jetconfig/test/load',
                allowClear: true
            });
        });

        after(function () {
            conf.clear();
        });

        it("should flatten objects", function () {
            var res = new Config().load({a: {b: {c: 1}}});
            res.should.eql({'a.b.c': 1});
        });

        it("should not flatten arrays", function () {
            var res = new Config().load({
                a: {arr: ['a', 'b', 3]}
            });
            res.should.eql({'a.arr': ['a', 'b', 3]});
        });

        it("should not flatten key values that already have dots", function () {
            var res = new Config().load({'a.b.c': {'a': 1}});
            res.should.eql({'a.b.c': {'a': 1}});
        });

        it("should merge multiple loads into cache", function () {
            var conf = new Config();
            var res;
            conf.load({a: {b: {c: 1}}, foo: 'bar'});
            res = conf.load({a: {b: {c: 2, d: 1}}, bar: 'foo'});
            res.should.eql({
                'a.b.c': 2,
                'a.b.d': 1,
                'foo': 'bar',
                'bar': 'foo'
            });
        });

        it("should load the current etcd config without args", function () {
            var opts = {prefix: 'jetconfig/test/load_etcd'};
            var conf = new Config(opts);
            var res;
            conf.set('test.conf1', {a: {b: 2}});
            conf.set('test.conf2', true);
            conf = new Config(opts);
            conf.cache.should.eql({});
            res = conf.load();
            res.should.eql({
                'test.conf1': {a: {b: 2}},
                'test.conf2': true
            });
            conf.get('test.conf1', {cacheOnly: true}).should.eql({a: {b: 2}});
            conf.get('test.conf2', {cacheOnly: true}).should.equal(true);
        });

        it("should be able to write a configuration to etcd", function () {
            conf.load({
                test1: true,
                test2: false
            }, {
                merge: false,
                cacheOnly: false
            });
            expect(conf.get('test1', undefined, {cached: false}))
                .to.equal(true);
            expect(conf.get('test2', undefined, {cached: false}))
                .to.equal(false);
        });
    });

    describe('#clear()', function () {
        var conf;

        before(function () {
            conf = new Config({
                prefix: 'jetconfig/test/clear',
                allowClear: true
            });
        });

        it("should return undefined if there's no keys", function () {
            expect(conf.clear()).to.be.undefined;
        });

        it("should remove the keys", function () {
            conf.set('test.key', 'one');
            conf.set('test.other', 2);
            conf.set('test.obj', {'a': 'b'});
            conf.clear();
            expect(conf.get('test.key')).to.be.undefined;
            expect(conf.get('test.other')).to.be.undefined;
            expect(conf.get('test.obj')).to.be.undefined;
        });

        it("should throw an error if it's not allowed", function () {
            var conf = new Config();
            expect(function () { conf.clear(); })
                .to.throw("clear() is not allowed on this instance");
        });

        it("should only clear the cache if that's specified", function () {
            conf.set('test.cacheOnly', true);
            conf.clear({cacheOnly: true});
            conf.get('test.cacheOnly').should.equal(true);
        });
    });

    describe('#list()', function () {
        var keys = ['test1', 'test2', 'test3'];
        var conf;
        before(function () {
            conf = new Config({prefix: 'jetconfig/list'});
            _.forEach(keys, function (key) {
                key = key + '/value';
                conf.set(key, 1);
            });
        });

        it("should list all the keys in the prefix", function () {
            var items = conf.list('');
            expect(items).to.not.be.undefined;
            items.sort().should.eql(keys.sort());
        });
    });

    describe('#log', function () {
        var conf;
        var JETCONFIG_LOGLEVEL;

        before(function () {
            // Ensure we don't break tests with environment vars
            JETCONFIG_LOGLEVEL = process.env.JETCONFIG_LOGLEVEL;
            delete process.env.JETCONFIG_LOGLEVEL;
            conf = new Config();
        });

        after(function () {
            // Restore the environment
            if (JETCONFIG_LOGLEVEL) {
                process.env.JETCONFIG_LOGLEVEL = JETCONFIG_LOGLEVEL;
            }
        });

        it("should allow the level to be set in the env", function () {
            var env_conf;
            process.env.JETCONFIG_LOGLEVEL = 'info';
            env_conf = new Config();
            delete process.env.JETCONFIG_LOGLEVEL;
            env_conf.log.level().should.equal('info');
        });

        describe('#level()', function () {
            it("should throw an error for unknown log levels", function () {
                expect(function () { conf.log.level('foolish'); })
                    .to.throw("Unknown log level 'foolish'");
            });

            it("should set a level correctly", function () {
                conf.log.level().should.equal('critical'); // Defaults critical
                conf.log.level('debug');
                conf.log.level().should.equal('debug'); // Changed to debug
                conf.log.level('critical');
                conf.log.level().should.equal('critical');
            });
        });

        describe('#debug()', function () {
            it("should log appropriately when the level is set", function () {
                conf.log.level('debug');
                // conf.log.debug("Testing");
            });
        });
    });

    describe('inheritance', function () {
        var conf;
        var base_conf;
        var child_conf;
        var shallow_conf;

        before(function () {
            conf = new Config({
                prefix: 'jetconfig/inherit/child',
                allowClear: true,
            });
            base_conf = new Config({
                prefix: 'jetconfig/inherit/base',
                allowClear: true,
            });
            child_conf = new Config({
                prefix: 'jetconfig/inherit/limited',
                allowClear: true,
                inheritDepth: 2,
            });
            shallow_conf = new Config({
                prefix: 'jetconfig/inherit/grandchild',
                allowClear: true,
                inheritDepth: 1,
            });

            base_conf.set('some.value', 1);
            base_conf.set('some.other.value', 1);

            conf.set(conf.inheritKey, 'jetconfig/inherit/base');
            conf.set('some.other.value', 2);

            child_conf.set(child_conf.inheritKey, 'jetconfig/inherit/child');

            shallow_conf.set(shallow_conf.inheritKey,
                    'jetconfig/inherit/child');
        });

        describe('new', function () {
            it("should be able to specify inheritance", function (){
                var base = 'jetconfig/inherit/base';
                var conf = new Config({
                    inherit: base
                });
                expect(conf.inheritConfig).to.not.be.undefined;
                expect(conf.inheritConfig).to.not.be.null;
                conf.inheritConfig.prefix.should.equal(base + '/');
            });

            it("should be able to disable inheritance", function () {
                var conf = new Config({
                    inherit: false
                });
                var called = 0;
                conf._inherited = function () {
                    called++;
                }.bind(conf);
                expect(conf.get('test')).to.be.undefined;
                called.should.equal(0);
            });
        });

        describe('#get()', function () {
            it("should inherit values", function () {
                expect(conf.get('some.other.value')).to.equal(2);
                expect(conf.get('some.value')).to.equal(1);
            });

            it("should do deep inheritance", function () {
                expect(child_conf.get('some.value')).to.equal(1);
                expect(child_conf.get('some.other.value')).to.equal(2);
            });

            it("should restrict inheritance depth to the limit specified",
                function () {
                expect(shallow_conf.get('some.other.value')).to.equal(2);
                expect(shallow_conf.get('some.value')).to.be.undefined;
            });

            it("should work with a callback", function (done) {
                conf.clear({cacheOnly: true});
                conf.get('some.value', function (err, val) {
                    if (err) return done(err);
                    expect(val).to.equal(1);
                    done();
                });
            });

        });

        describe('#dump()', function () {
            it("should inherit values", function () {
                var obj = conf.dump();
                expect(obj).to.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/base',
                    'some.other.value': 2,
                    'some.value': 1
                });
            });
            it("should do deep inheritance", function () {
                var obj = child_conf.dump();
                expect(obj).to.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/child',
                    'some.other.value': 2,
                    'some.value': 1
                });
            });
            it("should restrict inheritance depth to the limit specified",
                function () {
                var obj = shallow_conf.dump();
                expect(obj).to.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/child',
                    'some.other.value': 2,
                });
            });
            it("should be able to disable inheritance", function () {
                var obj = conf.dump({allowInherited: false});
                expect(obj).to.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/base',
                    'some.other.value': 2,
                });
            });
        });

        describe('#load()', function () {
            it("should inherit values", function () {
                conf.clear({cacheOnly: true});
                conf.cache.should.eql({});
                conf.load();
                conf.cache.should.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/base',
                    'some.value': 1,
                    'some.other.value': 2,
                });
            });
            it("should do deep inheritance", function () {
                child_conf.clear({cacheOnly: true});
                child_conf.cache.should.eql({});
                child_conf.load();
                child_conf.cache.should.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/child',
                    'some.value': 1,
                    'some.other.value': 2,
                });
            });
            it("should restrict inheritance depth to the limit specified",
                function () {
                shallow_conf.clear({cacheOnly: true});
                shallow_conf.cache.should.eql({});
                shallow_conf.load();
                shallow_conf.cache.should.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/child',
                    'some.other.value': 2,
                });
            });
            it("should be able to disable inheritance",
                function (){
                conf.clear({cacheOnly: true});
                conf.load(undefined, {allowInherited: false});
                conf.cache.should.eql({
                    'jetconfig.inherit': 'jetconfig/inherit/base',
                    'some.other.value': 2,
                });
            });
        });
    });
});

