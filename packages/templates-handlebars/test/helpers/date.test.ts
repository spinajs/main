import { expect } from 'chai';
import { DateTime } from 'luxon';
import * as dateHelpers from '../../src/helpers/date.js';

describe('Date Helpers', () => {
  const testDate = '2025-12-29T10:30:00.000Z';
  const testDate2 = '2025-12-31T10:30:00.000Z';

  describe('Format Date', () => {
    it('should format date from ISO string', () => {
      const result = dateHelpers.formatDate(testDate, 'dd/MM/yyyy');
      expect(result).to.match(/29\/12\/2025/);
    });

    it('should format Date object', () => {
      const date = new Date(testDate);
      const result = dateHelpers.formatDate(date, 'yyyy-MM-dd');
      expect(result).to.match(/2025-12-29/);
    });

    it('should format DateTime object', () => {
      const dt = DateTime.fromISO(testDate);
      const result = dateHelpers.formatDate(dt, 'yyyy-MM-dd');
      expect(result).to.match(/2025-12-29/);
    });

    it('should return empty string for invalid input', () => {
      expect(dateHelpers.formatDate(null, 'yyyy-MM-dd')).to.equal('');
    });
  });

  describe('Current Time', () => {
    it('should get current time', () => {
      const result = dateHelpers.now();
      expect(result).to.be.a('string');
      expect(result).to.include('T');
    });

    it('should format current time', () => {
      const result = dateHelpers.now('yyyy-MM-dd');
      expect(result).to.match(/\d{4}-\d{2}-\d{2}/);
    });
  });

  describe('Relative Dates', () => {
    it('should get relative time', () => {
      const result = dateHelpers.dateRelative(testDate);
      expect(result).to.be.a('string');
    });
  });

  describe('Date Arithmetic', () => {
    it('should add days to date', () => {
      const result = dateHelpers.dateAdd(testDate, 5, 'days');
      expect(result).to.include('2026-01-03');
    });

    it('should subtract days from date', () => {
      const result = dateHelpers.dateSubtract(testDate, 5, 'days');
      expect(result).to.include('2025-12-24');
    });

    it('should calculate difference in days', () => {
      const result = dateHelpers.dateDiff(testDate, testDate2, 'days');
      expect(result).to.equal(2);
    });
  });

  describe('Date Comparisons', () => {
    it('should check if date is before another', () => {
      expect(dateHelpers.dateBefore(testDate, testDate2)).to.be.true;
      expect(dateHelpers.dateBefore(testDate2, testDate)).to.be.false;
    });

    it('should check if date is after another', () => {
      expect(dateHelpers.dateAfter(testDate2, testDate)).to.be.true;
      expect(dateHelpers.dateAfter(testDate, testDate2)).to.be.false;
    });

    it('should check if date is between two dates', () => {
      const midDate = '2025-12-30T10:30:00.000Z';
      expect(dateHelpers.dateBetween(midDate, testDate, testDate2)).to.be.true;
      expect(dateHelpers.dateBetween(testDate, midDate, testDate2)).to.be.false;
    });
  });

  describe('Period Boundaries', () => {
    it('should get start of day', () => {
      const result = dateHelpers.dateStartOf(testDate, 'day');
      expect(result).to.include('T00:00:00');
    });

    it('should get end of day', () => {
      const result = dateHelpers.dateEndOf(testDate, 'day');
      expect(result).to.include('T23:59:59');
    });

    it('should get start of month', () => {
      const result = dateHelpers.dateStartOf(testDate, 'month');
      expect(result).to.include('2025-12-01');
    });
  });

  describe('Conversions', () => {
    it('should convert to ISO', () => {
      const result = dateHelpers.dateISO(new Date(testDate));
      expect(result).to.be.a('string');
      expect(result).to.include('T');
    });

    it('should get timestamp', () => {
      const result = dateHelpers.timestamp(testDate);
      expect(result).to.be.a('number');
      expect(result).to.be.greaterThan(0);
    });

    it('should get unix timestamp', () => {
      const result = dateHelpers.unixTimestamp(testDate);
      expect(result).to.be.a('number');
      expect(result).to.be.greaterThan(0);
    });

    it('should parse from timestamp', () => {
      const dt = DateTime.fromISO(testDate);
      const ts = dt.toMillis();
      const result = dateHelpers.fromTimestamp(ts);
      expect(result).to.be.a('string');
      expect(result).to.include('2025');
      expect(result).to.include('12-29');
    });
  });

  describe('Date Parts', () => {
    it('should get year', () => {
      expect(dateHelpers.year(testDate)).to.equal(2025);
    });

    it('should get month', () => {
      expect(dateHelpers.month(testDate)).to.equal(12);
    });

    it('should get day', () => {
      expect(dateHelpers.day(testDate)).to.equal(29);
    });

    it('should get hour', () => {
      const result = dateHelpers.hour(testDate);
      expect(result).to.be.a('number');
      expect(result).to.be.at.least(0);
      expect(result).to.be.at.most(23);
    });

    it('should get minute', () => {
      const result = dateHelpers.minute(testDate);
      expect(result).to.be.a('number');
      expect(result).to.be.at.least(0);
      expect(result).to.be.at.most(59);
    });

    it('should get weekday', () => {
      const result = dateHelpers.weekday(testDate);
      expect(result).to.be.a('number');
      expect(result).to.be.at.least(1);
      expect(result).to.be.at.most(7);
    });
  });
});
