import { expect } from 'chai';
import * as comparisonHelpers from '../../src/helpers/comparison.js';

describe('Comparison Helpers', () => {
  describe('Basic Comparisons', () => {
    it('should check equality', () => {
      expect(comparisonHelpers.eq(5, 5)).to.be.true;
      expect(comparisonHelpers.eq(5, 3)).to.be.false;
    });

    it('should check inequality', () => {
      expect(comparisonHelpers.ne(5, 3)).to.be.true;
      expect(comparisonHelpers.ne(5, 5)).to.be.false;
    });

    it('should check less than', () => {
      expect(comparisonHelpers.lt(3, 5)).to.be.true;
      expect(comparisonHelpers.lt(5, 3)).to.be.false;
    });

    it('should check greater than', () => {
      expect(comparisonHelpers.gt(5, 3)).to.be.true;
      expect(comparisonHelpers.gt(3, 5)).to.be.false;
    });

    it('should check less than or equal', () => {
      expect(comparisonHelpers.lte(3, 5)).to.be.true;
      expect(comparisonHelpers.lte(5, 5)).to.be.true;
      expect(comparisonHelpers.lte(5, 3)).to.be.false;
    });

    it('should check greater than or equal', () => {
      expect(comparisonHelpers.gte(5, 3)).to.be.true;
      expect(comparisonHelpers.gte(5, 5)).to.be.true;
      expect(comparisonHelpers.gte(3, 5)).to.be.false;
    });
  });

  describe('Parity Checks', () => {
    it('should check if number is odd', () => {
      expect(comparisonHelpers.isOdd(3)).to.be.true;
      expect(comparisonHelpers.isOdd(4)).to.be.false;
    });

    it('should check if number is even', () => {
      expect(comparisonHelpers.isEven(4)).to.be.true;
      expect(comparisonHelpers.isEven(3)).to.be.false;
    });
  });

  describe('Logical Operations', () => {
    it('should perform AND operation', () => {
      expect(comparisonHelpers.and(true, true, {})).to.be.true;
      expect(comparisonHelpers.and(true, false, {})).to.be.false;
      expect(comparisonHelpers.and(1, 'yes', true, {})).to.be.true;
    });

    it('should perform OR operation', () => {
      expect(comparisonHelpers.or(false, true, {})).to.be.true;
      expect(comparisonHelpers.or(false, false, {})).to.be.false;
      expect(comparisonHelpers.or(0, '', true, {})).to.be.true;
    });

    it('should perform NOT operation', () => {
      expect(comparisonHelpers.not(true)).to.be.false;
      expect(comparisonHelpers.not(false)).to.be.true;
      expect(comparisonHelpers.not(0)).to.be.true;
    });
  });

  describe('Null/Empty Checks', () => {
    it('should check if value is nil', () => {
      expect(comparisonHelpers.isNil(null)).to.be.true;
      expect(comparisonHelpers.isNil(undefined)).to.be.true;
      expect(comparisonHelpers.isNil(0)).to.be.false;
      expect(comparisonHelpers.isNil('')).to.be.false;
    });

    it('should check if value is truthy', () => {
      expect(comparisonHelpers.isTruthy(1)).to.be.true;
      expect(comparisonHelpers.isTruthy('hello')).to.be.true;
      expect(comparisonHelpers.isTruthy(0)).to.be.false;
      expect(comparisonHelpers.isTruthy('')).to.be.false;
    });

    it('should check if value is falsy', () => {
      expect(comparisonHelpers.isFalsy(0)).to.be.true;
      expect(comparisonHelpers.isFalsy('')).to.be.true;
      expect(comparisonHelpers.isFalsy(1)).to.be.false;
    });

    it('should check if value is empty', () => {
      expect(comparisonHelpers.isEmpty(null)).to.be.true;
      expect(comparisonHelpers.isEmpty('')).to.be.true;
      expect(comparisonHelpers.isEmpty([])).to.be.true;
      expect(comparisonHelpers.isEmpty({})).to.be.true;
      expect(comparisonHelpers.isEmpty('hello')).to.be.false;
      expect(comparisonHelpers.isEmpty([1])).to.be.false;
    });

    it('should check if value is not empty', () => {
      expect(comparisonHelpers.isNotEmpty('hello')).to.be.true;
      expect(comparisonHelpers.isNotEmpty([1])).to.be.true;
      expect(comparisonHelpers.isNotEmpty('')).to.be.false;
    });
  });

  describe('String Operations', () => {
    it('should check if array/string includes value', () => {
      expect(comparisonHelpers.includes([1, 2, 3], 2)).to.be.true;
      expect(comparisonHelpers.includes([1, 2, 3], 5)).to.be.false;
      expect(comparisonHelpers.includes('hello world', 'world')).to.be.true;
      expect(comparisonHelpers.includes('hello world', 'foo')).to.be.false;
    });

    it('should check if string starts with prefix', () => {
      expect(comparisonHelpers.startsWith('hello world', 'hello')).to.be.true;
      expect(comparisonHelpers.startsWith('hello world', 'world')).to.be.false;
    });

    it('should check if string ends with suffix', () => {
      expect(comparisonHelpers.endsWith('hello world', 'world')).to.be.true;
      expect(comparisonHelpers.endsWith('hello world', 'hello')).to.be.false;
    });
  });

  describe('Range Checks', () => {
    it('should check if value is between min and max', () => {
      expect(comparisonHelpers.between(5, 1, 10)).to.be.true;
      expect(comparisonHelpers.between(1, 1, 10)).to.be.true;
      expect(comparisonHelpers.between(10, 1, 10)).to.be.true;
      expect(comparisonHelpers.between(15, 1, 10)).to.be.false;
    });
  });

  describe('Generic Compare', () => {
    it('should compare with custom operator', () => {
      expect(comparisonHelpers.compare(5, '>', 3)).to.be.true;
      expect(comparisonHelpers.compare(5, '<', 3)).to.be.false;
      expect(comparisonHelpers.compare(5, '===', 5)).to.be.true;
      expect(comparisonHelpers.compare(5, '!==', 3)).to.be.true;
      expect(comparisonHelpers.compare(5, '<=', 5)).to.be.true;
      expect(comparisonHelpers.compare(5, '>=', 5)).to.be.true;
    });
  });
});
