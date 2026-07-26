import { expect } from 'chai';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { assert, assertNonNull, assertNonNil, assertString, assertNonEmptyString, assertNumber, assertArray, assertObject } from '../src/index.js';

describe('assert', () => {
  describe('assert', () => {
    it('passes when condition is true', () => {
      expect(() => assert(true, 'nope')).to.not.throw();
    });

    it('throws InvalidOperation with a string message', () => {
      expect(() => assert(false, 'bad state')).to.throw(InvalidOperation, 'bad state');
    });

    it('throws the given Error instance', () => {
      const err = new Error('custom');
      expect(() => assert(false, err)).to.throw(err);
    });
  });

  describe('assertNonNull', () => {
    it('passes for defined (incl. undefined) values', () => {
      expect(() => assertNonNull(0, 'x')).to.not.throw();
      expect(() => assertNonNull(undefined, 'x')).to.not.throw();
    });

    it('throws InvalidArgument for null', () => {
      expect(() => assertNonNull(null, 'x')).to.throw(InvalidArgument, 'x should not be null');
    });

    it('throws a custom error when provided', () => {
      const e = new InvalidArgument('boom');
      expect(() => assertNonNull(null, 'x', e)).to.throw(e);
    });
  });

  describe('assertNonNil', () => {
    it('passes for non-nil', () => {
      expect(() => assertNonNil(0, 'x')).to.not.throw();
      expect(() => assertNonNil('', 'x')).to.not.throw();
    });

    it('throws for null and undefined', () => {
      expect(() => assertNonNil(null, 'x')).to.throw(InvalidArgument);
      expect(() => assertNonNil(undefined, 'x')).to.throw(InvalidArgument);
    });
  });

  describe('assertString', () => {
    it('passes for strings', () => {
      expect(() => assertString('a', 'x')).to.not.throw();
    });
    it('throws for non-strings', () => {
      expect(() => assertString(1, 'x')).to.throw(InvalidArgument, 'x should be a string');
    });
  });

  describe('assertNonEmptyString', () => {
    it('passes for non-empty strings', () => {
      expect(() => assertNonEmptyString('a', 'x')).to.not.throw();
    });
    it('throws for empty string or non-string', () => {
      expect(() => assertNonEmptyString('', 'x')).to.throw(InvalidArgument);
      expect(() => assertNonEmptyString(5, 'x')).to.throw(InvalidArgument);
    });
  });

  describe('assertNumber', () => {
    it('passes for numbers', () => {
      expect(() => assertNumber(3.14, 'x')).to.not.throw();
    });
    it('throws for NaN and non-numbers', () => {
      expect(() => assertNumber(NaN, 'x')).to.throw(InvalidArgument);
      expect(() => assertNumber('5', 'x')).to.throw(InvalidArgument);
    });
  });

  describe('assertArray', () => {
    it('passes for arrays', () => {
      expect(() => assertArray([1], 'x')).to.not.throw();
    });
    it('throws for non-arrays', () => {
      expect(() => assertArray({}, 'x')).to.throw(InvalidArgument);
    });
  });

  describe('assertObject', () => {
    it('passes for plain objects', () => {
      expect(() => assertObject({ a: 1 }, 'x')).to.not.throw();
    });
    it('throws for null, arrays and primitives', () => {
      expect(() => assertObject(null, 'x')).to.throw(InvalidArgument);
      expect(() => assertObject([], 'x')).to.throw(InvalidArgument);
      expect(() => assertObject('s', 'x')).to.throw(InvalidArgument);
    });
  });

  it('uses the default name "value" when none is given', () => {
    expect(() => assertString(1)).to.throw(InvalidArgument, 'value should be a string');
  });
});
