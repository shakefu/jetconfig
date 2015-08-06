'use strict';
var chai = require('chai');
var expect = chai.expect;
var should = chai.should();

var jetconfig = require('../index.js');


describe('#get()', function (){
    it("should return a default value", function () {
        jetconfig.get('foo', true).should.equal(true);

    });
});
