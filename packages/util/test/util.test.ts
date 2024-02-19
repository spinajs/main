import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';

import { _check_arg, _default, _is_array, _is_object, _is_string, _max, _max_length, _min, _min_length, _non_nil, _non_null, _non_undefined, _is_number, _trim, _or, _between, _contains_key, _is_map, _is_boolean, _gt, _lt, _reg_match, _is_email, _is_uuid, _chain, _zip, _catch, _use, _fallback, _tap } from '../src/index.js';
import _ from 'lodash';



chai.use(chaiAsPromised);

describe('util', () => {

    describe('fp', () => {

        it('chain return last val', async () => {
            const a = () => Promise.resolve(1);
            const b = () => Promise.resolve(2);

            const res = await _chain(a, b);
            expect(res).to.be.eq(2);
        });

        it('chain compute', async () => {

            const a = () => Promise.resolve(1);
            const b = (val: number) => Promise.resolve(val + 1);
            const c = (val: number) => Promise.resolve(val + 1);
            const d = (val: number) => Promise.resolve(val + 1);

            const res = await _chain(a, b, c, d);
            expect(res).to.be.eq(4);
        });

        it('chain compute with error', async () => {

            const a = () => Promise.resolve(1);
            const b = (val: number) => Promise.resolve(val + 1);
            const c = (_val: number) => Promise.reject(new Error('error'));

            await expect(_chain(a, b, c)).to.be.rejectedWith(Error);
        });

        it('zip', async () => {
            const a = () => Promise.resolve(1);
            const b = () => Promise.resolve(2);

            const res = await _chain(_zip(a, b));
            expect(res).to.be.an('array');
            expect(res).to.have.lengthOf(2);
            expect(res).to.include(1);
            expect(res).to.include(2);
        });

        it('zip with error', async () => {
            const a = () => Promise.resolve(1);
            const b = () => Promise.reject(new Error('error'));

            await expect(_chain(_zip(a, b))).to.be.rejectedWith(Error);
        });

        it('zip with chained method', async () => {

            const a = () => Promise.resolve(1);
            const b = () => Promise.resolve(2);
            const c = (val: number[]) => Promise.resolve(val[0] + val[1]);

            const res = await _chain(_zip(a, b), c);
            expect(res).to.be.eq(3);
        });

        it('catch', async () => {
            const a = () => Promise.reject(new Error('error'));

            await expect(_chain(_catch(a, (err) => { throw err; }))).to.be.rejectedWith(Error);
        });

        it('catch with chained method', async () => {
            const a = () => Promise.reject(new Error('error'));
            const b = (val: number) => Promise.resolve(val + 1);

            await expect(_chain(_catch(a, (err) => { throw err; }), b)).to.be.rejectedWith(Error);
        });

        it('use', async () => {
            const a = () => Promise.resolve("service A");
            const b = () => Promise.resolve("service B");
            const c = ({ a, b }: { a: string, b: string }) => Promise.resolve({ a, b });

            const res = await _chain<{ a: string, b: string }>(_use(a, 'a'), _use(b, 'b'), c);
            expect(res).to.be.an('object');
            expect(res).to.have.property('a');
            expect(res).to.have.property('b');
            expect(res.a).to.be.eq('service A');
            expect(res.b).to.be.eq('service B');

        });

        it('use with error', async () => {
            const a = () => Promise.reject(new Error('error'));
            const b = () => Promise.resolve("service B");
            const c = ({ a, b }: { a: string, b: string }) => Promise.resolve({ a, b });

            await expect(_chain(_use(a, 'a'), _use(b, 'b'), c)).to.be.rejectedWith(Error);
        });

        it('fallback', async () => {
            const a = () => Promise.reject(new Error('error'));
            const b = () => Promise.resolve("service B");
            const c = ({ a, b }: { a: string, b: string }) => Promise.resolve({ a, b });

            const res = await _chain<{ a: string, b: string }>(_use(_fallback(a, (_err) => "fallback"), "a"), _use(b, 'b'), c);
            expect(res).to.be.an('object');
            expect(res).to.have.property('a');
            expect(res).to.have.property('b');
            expect(res.a).to.be.eq('fallback');
            expect(res.b).to.be.eq('service B');
        });

        it('_tap', async () => {
            const a = () => Promise.resolve("service A");
            const b = () => Promise.resolve("service B");

            const res = await _chain(a, _tap(b));
            expect(res).to.be.eq("service A");
        });
    });

    describe('args', () => {

        it('validate string', async () => {

            let val: string = "";

            val = _check_arg(_is_string())('test', 'test');
            expect(val).to.be.eq('test');

            expect(() => _check_arg(_is_string())(1234, 'test')).to.throw();

            val = _check_arg(_is_string(_min_length(10)))("hello world", 'test');
            expect(val).to.be.eq('hello world');

            expect(() => _check_arg(_is_string(_min_length(10)))("hello", 'test')).to.throw();
            expect(() => _check_arg(_is_string(_max_length(3)))("hello", 'test')).to.throw();

            val = _check_arg(_is_string(_max_length(3)))("hel", 'test');
            expect(val).to.be.eq('hel');

            val = _check_arg(_is_string(_between(3, 10)))("hello", 'test');
            expect(val).to.be.eq('hello');

            expect(() => _check_arg(_is_string(_max_length(3), _min_length(10)))("hello world world", 'test')).to.throw();

            val = _check_arg(_is_string(_trim()))(" hello ", 'test');
            expect(val).to.be.eq('hello');

            expect(() => _check_arg(_is_string(_trim(), _min_length(4)))("     f", 'test')).to.throw();

        });


        it('validate number', async () => {

            let val: number = 0;

            val = _check_arg(_is_number())(1234, 'test');
            expect(val).to.be.eq(1234);

            expect(() => _check_arg(_is_number())('test', 'test')).to.throw();
            val = _check_arg(_is_number(_min(10)))(11, 'test');
            expect(val).to.be.eq(11);

            expect(() => _check_arg(_is_number(_min(10)))(9, 'test')).to.throw();
            expect(() => _check_arg(_is_number(_max(10)))(11, 'test')).to.throw();
            val = _check_arg(_is_number(_max(10)))(9, 'test');
            expect(val).to.be.eq(9);
            expect(() => _check_arg(_is_number(_max(10), _min(5)))(11, 'test')).to.throw();

            val = _check_arg(_gt(10))(11, 'test');
            expect(val).to.be.eq(11);

            val = _check_arg(_lt(10))(9, 'test');
            expect(val).to.be.eq(9);

            expect(() => _check_arg(_gt(10))(6, 'test')).to.throw();
            expect(() => _check_arg(_lt(10))(11, 'test')).to.throw();

        });

        it('validate regex', async () => {

            let val: string = "";

            val = _check_arg(_reg_match(/^[a-z]+$/))('test', 'test');
            expect(val).to.be.eq('test');

            expect(() => _check_arg(_reg_match(/^[0-9]+$/))('test', 'test')).to.throw();

            val = _check_arg(_is_email())('test@wp.pl', 'test');
            expect(val).to.be.eq('test@wp.pl');

            expect(() => _check_arg(_is_email())('xxxx@xx', 'test')).to.throw();

            val = _check_arg(_is_uuid())('8b2f6f3e-5f6b-4e6d-8f2d-2e2c5b8b6f3e', 'test');
            expect(val).to.be.eq('8b2f6f3e-5f6b-4e6d-8f2d-2e2c5b8b6f3e');

            expect(() => _check_arg(_is_uuid())('xxxx', 'test')).to.throw();

        });

        it('validate null or undefined', async () => {

            let val: any = null;

            val = _check_arg(_non_null())(1234, 'test');
            expect(val).to.be.eq(1234);

            val = _check_arg(_non_null())('test', 'test');
            expect(val).to.be.eq('test');

            val = _check_arg(_non_null())(undefined, 'test');
            expect(val).to.be.eq(undefined);

            expect(() => _check_arg(_non_null())(null, 'test')).to.throw();

            val = _check_arg(_non_null())(0, 'test');
            expect(val).to.be.eq(0);

            val = _check_arg(_non_null())(false, 'test');
            expect(val).to.be.eq(false);

            val = _check_arg(_non_null())({}, 'test');
            expect(val).to.be.an('object');

            val = _check_arg(_non_undefined())(1234, 'test');
            expect(val).to.be.eq(1234);

            val = _check_arg(_non_undefined())('test', 'test');
            expect(val).to.be.eq('test');

            expect(() => _check_arg(_non_undefined())(undefined, 'test')).to.throw();

            val = _check_arg(_non_undefined())(null, 'test');
            expect(val).to.be.eq(null);

            val = _check_arg(_non_undefined())(0, 'test');
            expect(val).to.be.eq(0);

            val = _check_arg(_non_undefined())(false, 'test');
            expect(val).to.be.eq(false);

            val = _check_arg(_non_undefined())({}, 'test');
            expect(val).to.be.an('object');

            val = _check_arg(_non_nil())(1234, 'test');
            expect(val).to.be.eq(1234);

            val = _check_arg(_non_nil())('test', 'test');
            expect(val).to.be.eq('test');

            expect(() => _check_arg(_non_nil())(undefined, 'test')).to.throw();

            expect(() => _check_arg(_non_nil())(null, 'test')).to.throw();

            val = _check_arg(_non_nil())(0, 'test');
            expect(val).to.be.eq(0);

            val = _check_arg(_non_nil())(false, 'test');
            expect(val).to.be.eq(false);

            expect(() => _check_arg(_non_nil())({}, 'test')).to.throw();
            expect(() => _check_arg(_non_nil())([], 'test')).to.throw();
        });

        it('validate complex', async () => {
            let val: any = null;

            val = _check_arg(_or(_is_number(), _is_string(_trim(), _min_length(4))))("ffff", 'test');
            expect(val).to.be.eq("ffff");

            val = _check_arg(_or(_is_number(), _is_string(_trim(), _min_length(4))))(444, 'test');
            expect(val).to.be.eq(444);

            val = _check_arg(_is_number(), _non_nil())(444, 'test');
            expect(val).to.be.eq(444);

            expect(() => _check_arg(_is_number(), _non_nil())(undefined, 'test')).to.throw();
        });

        it('validate array', async () => {

            let val: any[] = [];

            val = _check_arg(_is_array())([], 'test');
            expect(val).to.be.an('array');

            val = _check_arg(_is_array())([1, 2, 3], 'test');
            expect(val).to.be.an('array');
            expect(val).to.have.lengthOf(3);
            expect(val).to.include(1);
            expect(() => _check_arg(_is_array())({}, 'test')).to.throw();

        });

        it('validate object', async () => {

            let val: any = {};

            val = _check_arg(_is_object())({}, 'test');
            expect(val).to.be.an('object');

            val = _check_arg(_is_object())({ a: 1 }, 'test');
            expect(val).to.be.an('object');

            expect(() => _check_arg(_is_object())(null, 'test')).to.throw();
            expect(() => _check_arg(_is_object())(undefined, 'test')).to.throw();
            expect(() => _check_arg(_is_object())("hello", 'test')).to.throw();
            expect(() => _check_arg(_is_object())(123, 'test')).to.throw();
            expect(() => _check_arg(_is_object())([], 'test')).to.throw();
            expect(() => _check_arg(_is_object())(true, 'test')).to.throw();

            expect(() => _check_arg(_contains_key('a'))({}, 'test')).to.throw();
            val = _check_arg(_contains_key('a'))({ a: 1 }, 'test');
            expect(val).to.be.an('object');
            expect(val).to.have.property('a');
            expect(val.a).to.be.eq(1);
        });

        it('validate map', async () => {

            let val: Map<string, any> = new Map();

            val = _check_arg(_is_map())(new Map(), 'test');
            expect(val).to.be.an.instanceOf(Map);

            expect(() => _check_arg(_is_map())({}, 'test')).to.throw();

            val = _check_arg(_is_map(_contains_key('a')))(new Map([['a', 1]]), 'test');
            expect(val).to.be.an.instanceOf(Map);
            expect(val.get('a')).to.be.eq(1);
        });

        it('validate boolean', async () => {

            let val: boolean = false;

            val = _check_arg(_is_boolean())(true, 'test');
            expect(val).to.be.eq(true);

            val = _check_arg(_is_boolean())(false, 'test');
            expect(val).to.be.eq(false);

            val = _check_arg(_is_boolean())(0, 'test');
            expect(val).to.be.eq(0);

            val = _check_arg(_is_boolean())(1, 'test');
            expect(val).to.be.eq(1);

            expect(() => _check_arg(_is_boolean())("hello", 'test')).to.throw();
            expect(() => _check_arg(_is_boolean())({}, 'test')).to.throw();
            expect(() => _check_arg(_is_boolean())([], 'test')).to.throw();

        });

        it('returns default value', async () => {

            let val: any = {};

            val = _check_arg(_is_string(), _default("hello"))("", 'test');
            expect(val).to.be.eq("hello");

            val = _check_arg(_default("hello"))(null, 'test');
            expect(val).to.be.eq("hello");

            val = _check_arg(_default("hello"))(undefined, 'test');
            expect(val).to.be.eq("hello");

            val = _check_arg(_default(["hello"]))([], 'test');
            expect(val).to.be.an('array');
            expect(val).to.have.lengthOf(1);
            expect(val).to.include("hello");

            val = _check_arg(_default({ a: 1 }))({}, 'test');
            expect(val).to.be.an('object');
            expect(val).to.have.property('a');
            expect(val.a).to.be.eq(1);

        });

    });

});
