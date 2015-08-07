var pkg = require('../package.json');
var Etcd = require('node-etcd');
var chai = require('chai');
chai.should();
// var expect = chai.expect;
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


describe('#get()', function (){
    var conf = new Config();

    it("should return a default value", function () {
        conf.get('foo', true).should.equal(true);

    });
});
