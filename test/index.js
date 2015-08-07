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
        it("should be required", function () {
            expect(Config).to.throw("AssertionError: Missing 'new' keyword");
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
