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
    etcd.setSync('jetconfig', pkg.version, {ttl: 1});
    var res = etcd.getSync('jetconfig');
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
    });

    describe('#get()', function (){
        var conf;

        before(function (){
            conf = new Config();
        });

        it("should return a default value", function () {
            conf.get('foo', true).should.equal(true);

        });

        it("should work with a callback", function (done) {
            conf.get('foo', true, function (err, val) {
                if (err) return done(err);
                expect(val).to.not.be.null;
                val.should.equal(true);
                done();
            });
        });
    });
});
