import { expect } from 'chai';
import * as mathHelpers from '../../src/helpers/math.js';

describe('Math Helpers', () => {
  describe('Basic Operations', () => {
    it('should add numbers', () => {
      expect(mathHelpers.add(5, 3, {})).to.equal(8);
      expect(mathHelpers.add(1, 2, 3, 4, {})).to.equal(10);
    });

    it('should subtract numbers', () => {
      expect(mathHelpers.subtract(10, 3)).to.equal(7);
    });

    it('should multiply numbers', () => {
      expect(mathHelpers.multiply(5, 3, {})).to.equal(15);
      expect(mathHelpers.multiply(2, 3, 4, {})).to.equal(24);
    });

    it('should divide numbers', () => {
      expect(mathHelpers.divide(10, 2)).to.equal(5);
    });

    it('should calculate modulo', () => {
      expect(mathHelpers.modulo(10, 3)).to.equal(1);
    });
  });

  describe('Rounding', () => {
    it('should get absolute value', () => {
      expect(mathHelpers.abs(-5)).to.equal(5);
      expect(mathHelpers.abs(5)).to.equal(5);
    });

    it('should round number', () => {
      expect(mathHelpers.round(3.7)).to.equal(4);
      expect(mathHelpers.round(3.4)).to.equal(3);
    });

    it('should floor number', () => {
      expect(mathHelpers.floor(3.7)).to.equal(3);
    });

    it('should ceil number', () => {
      expect(mathHelpers.ceil(3.2)).to.equal(4);
    });

    it('should convert to fixed decimals', () => {
      expect(mathHelpers.toFixed(3.14159, 2)).to.equal('3.14');
    });

    it('should convert to integer', () => {
      expect(mathHelpers.toInt('42')).to.equal(42);
      expect(mathHelpers.toInt(3.7)).to.equal(3);
      expect(mathHelpers.toInt('FF', 16)).to.equal(255);
    });
  });

  describe('Advanced Math', () => {
    it('should calculate power', () => {
      expect(mathHelpers.pow(2, 3)).to.equal(8);
    });

    it('should calculate square root', () => {
      expect(mathHelpers.sqrt(16)).to.equal(4);
    });

    it('should find minimum', () => {
      expect(mathHelpers.min(5, 2, 8, 1, {})).to.equal(1);
    });

    it('should find maximum', () => {
      expect(mathHelpers.max(5, 2, 8, 1, {})).to.equal(8);
    });

    it('should calculate average', () => {
      expect(mathHelpers.avg(10, 20, 30, {})).to.equal(20);
    });

    it('should calculate sum', () => {
      expect(mathHelpers.sum(10, 20, 30, {})).to.equal(60);
    });
  });

  describe('Random', () => {
    it('should generate random number between 0 and 1', () => {
      const result = mathHelpers.random();
      expect(result).to.be.at.least(0);
      expect(result).to.be.at.most(1);
    });

    it('should generate random integer in range', () => {
      const result = mathHelpers.randomInt(1, 10);
      expect(result).to.be.at.least(1);
      expect(result).to.be.at.most(10);
      expect(Number.isInteger(result)).to.be.true;
    });
  });

  describe('Utilities', () => {
    it('should clamp value', () => {
      expect(mathHelpers.clamp(15, 0, 10)).to.equal(10);
      expect(mathHelpers.clamp(-5, 0, 10)).to.equal(0);
      expect(mathHelpers.clamp(5, 0, 10)).to.equal(5);
    });

    it('should calculate percentage', () => {
      expect(mathHelpers.percentage(25, 200)).to.equal(12.5);
      expect(mathHelpers.percentage(50, 100)).to.equal(50);
    });
  });

  describe('Formatting', () => {
    it('should format number with separators', () => {
      const result = mathHelpers.formatNumber(1234567);
      expect(result).to.equal('1,234,567');
    });

    it('should format as currency', () => {
      const result = mathHelpers.currency(1234.56, 'USD');
      expect(result).to.include('1,234.56');
      expect(result).to.match(/\$|USD/);
    });
  });
});
