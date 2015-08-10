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
    etcd.setSync('test/jetconfig', pkg.version, {ttl: 1});
    var res = etcd.getSync('test/jetconfig');
    if (!res || !res.body || !res.body.node ||
        res.body.node.value !== pkg.version ){
        return done(new Error("etcd not working properly, aborting tests"));
    }
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
            conf = new Config();
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

        it("should work for a lot of value types", function () {
            conf.set('string', 'a');
            conf.get('string').should.equal('a');

            conf.set('number', 32);
            conf.get('number').should.equal(32);

            conf.set('float', 5.5);
            conf.get('float').should.equal(5.5);

            conf.set('object', {'foo': 'bar'});
            conf.get('object').should.eql({'foo': 'bar'});

            conf.set('bool', false);
            conf.get('bool').should.equal(false);

            conf.set('array', ['a', 2, false]);
            conf.get('array').should.eql(['a', 2, false]);
        });
    });

    describe('#dump()', function () {
        var conf;

        before(function () {
            conf = new Config({prefix: 'dump'});
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

