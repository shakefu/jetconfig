var chai = require('chai');
chai.should();
// var expect = chai.expect;
// var should = chai.should();

var jetconfig = require('../index.js');


before(function (done) {
    console.dir(process.env);
    done(new Error("Does this work?"));
});


describe('#get()', function (){
    it("should return a default value", function () {
        jetconfig.get('foo', true).should.equal(true);

    });
});
