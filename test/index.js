/* jshint expr:true */
var pkg = require('../package.json');
var Etcd = require('node-etcd');
var chai = require('chai');
var expect = chai.expect;
chai.should();
// var should = chai.should();

var Config = require('../index.js');


before(function (done) {
    var etcd = new Etcd();
    var key = 'jetconfig/test/version';
    etcd.setSync(key, pkg.version, {ttl: 1});
    var res = etcd.getSync(key);
    if (!res || !res.body || !res.body.node ||
        res.body.node.value !== pkg.version ){
        return done(new Error("etcd not working properly, aborting tests"));
    }
    // Uncomment this to get helpful debug logging for all the tests
    // process.env.JETCONFIG_LOGLEVEL = 'debug';
    done();
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
            process.env.JETCONFIG_ETCD = host2;
            var conf = new Config();
            conf.hosts.should.eql([host2]);
            delete process.env.JETCONFIG_ETCD;
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
            var conf = new Config({prefix: ' foo/ '});
            conf.prefix.should.equal('foo/');
        });

        it("should add a trailing slash to a prefix", function () {
            var conf = new Config({prefix: 'foo'});
            conf.prefix.should.equal('foo/');
        });

        it("should trim leading slashes on the prefix", function () {
            var conf = new Config({prefix: '/bar'});
            conf.prefix.should.equal('bar/');
        });

        it("should require cache option to be boolean", function () {
            expect(function () { new Config({cache: 'foo'}); }) // jshint ignore:line
                .to.throw("cache must be boolean");
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
    });

    describe('#dump()', function () {
        var conf;

        before(function () {
            conf = new Config({prefix: 'jetconfig/dump'});
        });

        it("should work", function () {
            conf.set('ph.alpha', 'a');
            conf.set('ph.beta', 'b');
            conf.set('ph.obj', {'o': 1});
            var dump = conf.dump();
            expect(dump).to.not.be.undefined;
            dump.should.eql({
                'ph.alpha': 'a',
                'ph.beta': 'b',
                'ph.obj': {'o': 1}
            });
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

    describe('log', function () {
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
            process.env.JETCONFIG_LOGLEVEL = 'debug';
            env_conf = new Config();
            delete process.env.JETCONFIG_LOGLEVEL;
            env_conf.log.level().should.equal('debug');
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
});

