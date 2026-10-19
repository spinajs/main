import { expect } from 'chai';
import { describeError, errorClassOf, errorMessage, InvalidOption, isErrorOf, toError } from '../src/index.js';

// A second copy of a class, as the cjs and the mjs build of one package each define it.
const otherCopy = () => {
  class InvalidOption extends Error {}
  class Narrower extends InvalidOption {}
  return { InvalidOption, Narrower };
};

const throwing = new Proxy(new Error('secret'), {
  get() {
    throw new Error('getter');
  },
});

describe('error description helpers', () => {
  describe('errorClassOf', () => {
    it('gives the name of a built-in error', () => {
      expect(errorClassOf(new TypeError('x'))).to.eq('TypeError');
    });

    it('gives the class of a subclass that leaves name as Error', () => {
      expect(errorClassOf(new InvalidOption('x'))).to.eq('InvalidOption');
    });

    it('prefers a name the error set over its constructor', () => {
      const err = new Error('x');
      err.name = 'AbortError';
      expect(errorClassOf(err)).to.eq('AbortError');
    });

    it('gives the typeof of a non-Error and never its content', () => {
      expect(errorClassOf('the password')).to.eq('string');
      expect(errorClassOf({ name: 'Fake', message: 'm' })).to.eq('object');
      expect(errorClassOf(undefined)).to.eq('undefined');
      expect(errorClassOf(null)).to.eq('null');
    });

    it('does not throw on an error whose getters throw', () => {
      expect(errorClassOf(throwing)).to.eq('Error');
    });
  });

  describe('errorMessage', () => {
    it('gives the message of an Error', () => {
      expect(errorMessage(new InvalidOption('bad key'))).to.eq('bad key');
    });

    it('gives a string as is and a primitive through String()', () => {
      expect(errorMessage('boom')).to.eq('boom');
      expect(errorMessage(42)).to.eq('42');
      expect(errorMessage(undefined)).to.eq('undefined');
      expect(errorMessage(null)).to.eq('null');
    });

    it('gives only the tag of an object, not its contents or its own toString', () => {
      expect(errorMessage({ token: 'secret', toString: () => 'secret' })).to.eq('[object Object]');
      expect(errorMessage([1, 2])).to.eq('[object Array]');
    });

    it('does not throw on an error whose getters throw', () => {
      expect(errorMessage(throwing)).to.eq('unprintable error');
    });
  });

  describe('describeError', () => {
    it('prefixes an Error with its class', () => {
      expect(describeError(new RangeError('out'))).to.eq('RangeError: out');
      expect(describeError(new InvalidOption('bad key'))).to.eq('InvalidOption: bad key');
    });

    it('gives the class alone for an empty message', () => {
      expect(describeError(new TypeError())).to.eq('TypeError');
    });

    it('gives the message alone with withClass: false', () => {
      expect(describeError(new RangeError('out'), { withClass: false })).to.eq('out');
    });

    it('describes a non-Error without a class', () => {
      expect(describeError('boom')).to.eq('boom');
      expect(describeError({ a: 1 })).to.eq('[object Object]');
    });
  });

  describe('toError', () => {
    it('returns an Error itself', () => {
      const err = new InvalidOption('x');
      expect(toError(err)).to.eq(err);
    });

    it('wraps a non-Error in an Error carrying its description only', () => {
      const wrapped = toError({ token: 'secret' });
      expect(wrapped).to.be.instanceOf(Error);
      expect(wrapped.message).to.eq('[object Object]');
      expect(wrapped.cause).to.eq(undefined);
      expect(toError('boom').message).to.eq('boom');
    });
  });

  describe('isErrorOf', () => {
    it('matches an instance and an instance of a subclass', () => {
      class Narrower extends InvalidOption {}
      expect(isErrorOf(new InvalidOption('x'), InvalidOption)).to.eq(true);
      expect(isErrorOf(new Narrower('x'), InvalidOption)).to.eq(true);
    });

    it('matches an error of another copy of the class, and of its subclasses', () => {
      const copy = otherCopy();
      expect(isErrorOf(new copy.InvalidOption('x'), InvalidOption)).to.eq(true);
      expect(isErrorOf(new copy.Narrower('x'), InvalidOption)).to.eq(true);
    });

    it('does not match an unrelated class or a mere name field', () => {
      const fake = new Error('x');
      fake.name = 'InvalidOption';
      expect(isErrorOf(new TypeError('x'), InvalidOption)).to.eq(false);
      expect(isErrorOf(fake, InvalidOption)).to.eq(false);
      expect(isErrorOf({ name: 'InvalidOption' }, InvalidOption)).to.eq(false);
      expect(isErrorOf(null, InvalidOption)).to.eq(false);
      expect(isErrorOf('InvalidOption', InvalidOption)).to.eq(false);
    });

    it('does not throw on an error whose getters throw', () => {
      expect(isErrorOf(throwing, InvalidOption)).to.eq(false);
    });
  });
});
