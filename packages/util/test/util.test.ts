import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';

import { _check_arg, _max, _max_length, _min, _min_length, _non_nil, _non_null, _non_undefined, _number, _string, _trim } from '../src/index.js';
import _ from 'lodash';


chai.use(chaiAsPromised);

describe('util', () => {

    describe('args', () => {

        it('validate string', async () => {

            let val: string = "";

            val = _check_arg(_string())('test', 'test');
            val = _check_arg(_string())(1234, 'test');
            val = _check_arg(_string(_min_length(10)))("hello world", 'test');
            val = _check_arg(_string(_min_length(10)))("hello", 'test');
            val = _check_arg(_string(_max_length(3)))("hello", 'test');
            val = _check_arg(_string(_max_length(3)))("hel", 'test');
            val = _check_arg(_string(_max_length(3), _min_length(10)))("hello", 'test');
            val = _check_arg(_string(_trim()))(" hello ", 'test');
            val = _check_arg(_string(_trim(), _min_length(4)))("     f", 'test');

        });


        it('validate number', async () => {

            let val: number = 0;

            val = _check_arg(_number())(1234, 'test');
            val = _check_arg(_number())('test', 'test');
            val = _check_arg(_number(_min(10)))(11, 'test');
            val = _check_arg(_number(_min(10)))(9, 'test');
            val = _check_arg(_number(_max(10)))(11, 'test');
            val = _check_arg(_number(_max(10)))(9, 'test');
            val = _check_arg(_number(_max(10), _min(5)))(11, 'test');

        });

        it('validate null or undefined', async () => {

            let val: any = null;

            val = _check_arg(_non_null())(1234, 'test');
            val = _check_arg(_non_null())('test', 'test');
            val = _check_arg(_non_null())(undefined, 'test');
            val = _check_arg(_non_null())(null, 'test');
            val = _check_arg(_non_null())(0, 'test');
            val = _check_arg(_non_null())(false, 'test');
            val = _check_arg(_non_null())({}, 'test');

            val = _check_arg(_non_undefined())(1234, 'test');
            val = _check_arg(_non_undefined())('test', 'test');
            val = _check_arg(_non_undefined())(undefined, 'test');
            val = _check_arg(_non_undefined())(null, 'test');
            val = _check_arg(_non_undefined())(0, 'test');
            val = _check_arg(_non_undefined())(false, 'test');
            val = _check_arg(_non_undefined())({}, 'test');

            val = _check_arg(_non_nil())(1234, 'test');
            val = _check_arg(_non_nil())('test', 'test');
            val = _check_arg(_non_nil())(undefined, 'test');
            val = _check_arg(_non_nil())(null, 'test');
            val = _check_arg(_non_nil())(0, 'test');
            val = _check_arg(_non_nil())(false, 'test');
            val = _check_arg(_non_nil())({}, 'test');

        });

        it('validate complex', async () => {

            _check_arg(_number(), _string(_trim(), _min_length(4)))("ffff", 'test');
            _check_arg(_number(), _string(_trim(), _min_length(4)))(444, 'test');
            _check_arg(_number(), _non_nil())(444, 'test');
            _check_arg(_number(), _non_nil())(undefined, 'test');


        });

    });

});
