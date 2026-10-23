import { expect } from 'chai';
import { TimeSpan } from '../src/timespan.js';
import { DateTime } from 'luxon';
import 'mocha';

describe('TimeSpan', () => {
  describe('Constructor and Constants', () => {

    it('should have correct constant values', () => {
      expect(TimeSpan.MILLIS_PER_SECOND).to.equal(1000);
      expect(TimeSpan.MILLIS_PER_MINUTE).to.equal(60000);
      expect(TimeSpan.MILLIS_PER_HOUR).to.equal(3600000);
      expect(TimeSpan.MILLIS_PER_DAY).to.equal(86400000);
    });
  });

  describe('Add Methods', () => {
    it('should add TimeSpan to TimeSpan', () => {
      const ts1 = TimeSpan.fromHours(2);
      const ts2 = TimeSpan.fromHours(3);
      const result = ts1.add(ts2);
      expect(result.totalHours).to.equal(5);
    });

    it('should add days', () => {
      const ts = TimeSpan.fromDays(1);
      const result = ts.addDays(2);
      expect(result.totalDays).to.equal(3);
    });

    it('should add hours', () => {
      const ts = TimeSpan.fromHours(1);
      const result = ts.addHours(2);
      expect(result.totalHours).to.equal(3);
    });

    it('should add minutes', () => {
      const ts = TimeSpan.fromMinutes(30);
      const result = ts.addMinutes(45);
      expect(result.totalMinutes).to.equal(75);
    });

    it('should add seconds', () => {
      const ts = TimeSpan.fromSeconds(30);
      const result = ts.addSeconds(45);
      expect(result.totalSeconds).to.equal(75);
    });

    it('should add milliseconds', () => {
      const ts = TimeSpan.fromMilliseconds(500);
      const result = ts.addMilliseconds(300);
      expect(result.totalMilliseconds).to.equal(800);
    });
  });

  describe('Subtract Methods', () => {
    it('should subtract TimeSpan from TimeSpan', () => {
      const ts1 = TimeSpan.fromHours(5);
      const ts2 = TimeSpan.fromHours(3);
      const result = ts1.subtract(ts2);
      expect(result.totalHours).to.equal(2);
    });

    it('should subtract days', () => {
      const ts = TimeSpan.fromDays(5);
      const result = ts.subtractDays(2);
      expect(result.totalDays).to.equal(3);
    });

    it('should subtract hours', () => {
      const ts = TimeSpan.fromHours(5);
      const result = ts.subtractHours(2);
      expect(result.totalHours).to.equal(3);
    });

    it('should subtract minutes', () => {
      const ts = TimeSpan.fromMinutes(75);
      const result = ts.subtractMinutes(30);
      expect(result.totalMinutes).to.equal(45);
    });

    it('should subtract seconds', () => {
      const ts = TimeSpan.fromSeconds(90);
      const result = ts.subtractSeconds(30);
      expect(result.totalSeconds).to.equal(60);
    });

    it('should subtract milliseconds', () => {
      const ts = TimeSpan.fromMilliseconds(1000);
      const result = ts.subtractMilliseconds(300);
      expect(result.totalMilliseconds).to.equal(700);
    });
  });

  describe('Comparison Methods', () => {
    it('should check equality', () => {
      const ts1 = TimeSpan.fromHours(2);
      const ts2 = TimeSpan.fromHours(2);
      const ts3 = TimeSpan.fromHours(3);
      
      expect(ts1.equals(ts2)).to.be.true;
      expect(ts1.equals(ts3)).to.be.false;
      expect(ts1.equals(null)).to.be.false;
      expect(ts1.equals('not a timespan')).to.be.false;
    });

    it('should compare timespans', () => {
      const ts1 = TimeSpan.fromHours(2);
      const ts2 = TimeSpan.fromHours(3);
      const ts3 = TimeSpan.fromHours(2);

      expect(ts1.compareTo(ts2)).to.equal(-1);
      expect(ts2.compareTo(ts1)).to.equal(1);
      expect(ts1.compareTo(ts3)).to.equal(0);
    });

    it('should check greater than', () => {
      const ts1 = TimeSpan.fromHours(3);
      const ts2 = TimeSpan.fromHours(2);
      
      expect(ts1.greaterThan(ts2)).to.be.true;
      expect(ts2.greaterThan(ts1)).to.be.false;
      expect(ts1.greaterThan(ts1)).to.be.false;
    });

    it('should check greater than or equal', () => {
      const ts1 = TimeSpan.fromHours(3);
      const ts2 = TimeSpan.fromHours(2);
      const ts3 = TimeSpan.fromHours(3);
      
      expect(ts1.greaterThanOrEqual(ts2)).to.be.true;
      expect(ts1.greaterThanOrEqual(ts3)).to.be.true;
      expect(ts2.greaterThanOrEqual(ts1)).to.be.false;
    });

    it('should check less than', () => {
      const ts1 = TimeSpan.fromHours(2);
      const ts2 = TimeSpan.fromHours(3);
      
      expect(ts1.lessThan(ts2)).to.be.true;
      expect(ts2.lessThan(ts1)).to.be.false;
      expect(ts1.lessThan(ts1)).to.be.false;
    });

    it('should check less than or equal', () => {
      const ts1 = TimeSpan.fromHours(2);
      const ts2 = TimeSpan.fromHours(3);
      const ts3 = TimeSpan.fromHours(2);
      
      expect(ts1.lessThanOrEqual(ts2)).to.be.true;
      expect(ts1.lessThanOrEqual(ts3)).to.be.true;
      expect(ts2.lessThanOrEqual(ts1)).to.be.false;
    });
  });

  describe('Time Range Checking', () => {
    describe('isTimeInRange with Date', () => {

      it('should return false if time is after range', () => {
        const timeSpan = TimeSpan.fromTime(20, 0, 0); // 8:00 PM
        const startDate = new Date('2023-01-01T14:00:00Z'); // 2:00 PM
        const endDate = new Date('2023-01-01T17:00:00Z');   // 5:00 PM
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.false;
      });

      it('should handle range crossing midnight', () => {
        const timeSpan = TimeSpan.fromTime(23, 30, 0); // 11:30 PM
        const startDate = new Date('2023-01-01T22:00:00Z'); // 10:00 PM
        const endDate = new Date('2023-01-01T02:00:00Z');   // 2:00 AM (next day)
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.true;
      });

      it('should handle time after midnight in cross-midnight range', () => {
        const timeSpan = TimeSpan.fromTime(1, 0, 0); // 1:00 AM
        const startDate = new Date('2023-01-01T22:00:00Z'); // 10:00 PM
        const endDate = new Date('2023-01-01T02:00:00Z');   // 2:00 AM
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.true;
      });

      it('should return false for time outside cross-midnight range', () => {
        const timeSpan = TimeSpan.fromTime(12, 0, 0); // 12:00 PM
        const startDate = new Date('2023-01-01T22:00:00Z'); // 10:00 PM
        const endDate = new Date('2023-01-01T02:00:00Z');   // 2:00 AM
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.false;
      });

      it('should handle exact boundary times', () => {
        const timeSpan1 = TimeSpan.fromTime(14, 0, 0); // 2:00 PM
        const timeSpan2 = TimeSpan.fromTime(17, 0, 0); // 5:00 PM
        // Create dates in local timezone
        const startDate = new Date(2023, 0, 1, 14, 0, 0); // 2:00 PM local
        const endDate = new Date(2023, 0, 1, 17, 0, 0);   // 5:00 PM local
        
        expect(timeSpan1.isTimeInRange(startDate, endDate)).to.be.true;
        expect(timeSpan2.isTimeInRange(startDate, endDate)).to.be.true;
      });
    });

    describe('isTimeInRange with DateTime', () => {

      it('should return false if time is before range', () => {
        const timeSpan = TimeSpan.fromTime(10, 0, 0);
        const startDateTime = DateTime.fromISO('2023-01-01T14:00:00');
        const endDateTime = DateTime.fromISO('2023-01-01T17:00:00');
        
        expect(timeSpan.isTimeInRange(startDateTime, endDateTime)).to.be.false;
      });
    });

    describe('isBetween with TimeSpan', () => {

      it('should return false if time is before range', () => {
        const time = TimeSpan.fromTime(10, 0, 0);
        const start = TimeSpan.fromTime(14, 0, 0);
        const end = TimeSpan.fromTime(17, 0, 0);
        
        expect(time.isBetween(start, end)).to.be.false;
      });

      it('should return false if time is after range', () => {
        const time = TimeSpan.fromTime(20, 0, 0);
        const start = TimeSpan.fromTime(14, 0, 0);
        const end = TimeSpan.fromTime(17, 0, 0);
        
        expect(time.isBetween(start, end)).to.be.false;
      });

      it('should handle range crossing midnight', () => {
        const time = TimeSpan.fromTime(23, 30, 0); // 11:30 PM
        const start = TimeSpan.fromTime(22, 0, 0); // 10:00 PM
        const end = TimeSpan.fromTime(2, 0, 0);    // 2:00 AM
        
        expect(time.isBetween(start, end)).to.be.true;
      });

      it('should handle time after midnight in cross-midnight range', () => {
        const time = TimeSpan.fromTime(1, 0, 0);   // 1:00 AM
        const start = TimeSpan.fromTime(22, 0, 0); // 10:00 PM
        const end = TimeSpan.fromTime(2, 0, 0);    // 2:00 AM
        
        expect(time.isBetween(start, end)).to.be.true;
      });

      it('should return false for time outside cross-midnight range', () => {
        const time = TimeSpan.fromTime(12, 0, 0);  // 12:00 PM
        const start = TimeSpan.fromTime(22, 0, 0); // 10:00 PM
        const end = TimeSpan.fromTime(2, 0, 0);    // 2:00 AM
        
        expect(time.isBetween(start, end)).to.be.false;
      });

      it('should handle negative TimeSpan', () => {
        const time = TimeSpan.fromTime(-8, -30, 0); // Should normalize
        const start = TimeSpan.fromTime(14, 0, 0);
        const end = TimeSpan.fromTime(17, 0, 0);
        
        // -8:30 normalizes to 15:30
        expect(time.isBetween(start, end)).to.be.true;
      });

      it('should handle exact boundary times', () => {
        const start = TimeSpan.fromTime(14, 0, 0);
        const end = TimeSpan.fromTime(17, 0, 0);
        const time1 = TimeSpan.fromTime(14, 0, 0);
        const time2 = TimeSpan.fromTime(17, 0, 0);
        
        expect(time1.isBetween(start, end)).to.be.true;
        expect(time2.isBetween(start, end)).to.be.true;
      });
    });
  });

  describe('Utility Methods', () => {

    it('should get absolute value', () => {
      const ts1 = TimeSpan.fromHours(-5);
      const ts2 = TimeSpan.fromHours(5);
      
      expect(ts1.abs().totalHours).to.equal(5);
      expect(ts2.abs().totalHours).to.equal(5);
    });

    it('should get duration (alias for abs)', () => {
      const ts = TimeSpan.fromHours(-5);
      expect(ts.duration().totalHours).to.equal(5);
    });

    it('should multiply TimeSpan', () => {
      const ts = TimeSpan.fromHours(2);
      const result = ts.multiply(3);
      expect(result.totalHours).to.equal(6);
    });

    it('should divide TimeSpan', () => {
      const ts = TimeSpan.fromHours(6);
      const result = ts.divide(3);
      expect(result.totalHours).to.equal(2);
    });

    it('should throw error when dividing by zero', () => {
      const ts = TimeSpan.fromHours(6);
      expect(() => ts.divide(0)).to.throw('Cannot divide TimeSpan by zero');
    });

    it('should convert to object', () => {
      const ts = TimeSpan.fromTime(1, 2, 30, 45, 500);
      const obj = ts.toObject();
      
      expect(obj.days).to.equal(1);
      expect(obj.hours).to.equal(2);
      expect(obj.minutes).to.equal(30);
      expect(obj.seconds).to.equal(45);
      expect(obj.milliseconds).to.equal(500);
    });

    it('should return value with valueOf', () => {
      const ts = TimeSpan.fromSeconds(10);
      expect(ts.valueOf()).to.equal(10000);
    });

    it('should convert to JSON', () => {
      const ts = TimeSpan.fromTime(2, 30, 45);
      const json = ts.toJSON();
      expect(json).to.be.a('string');
      expect(json).to.equal('02:30:45');
    });
  });

  describe('String Conversion', () => {

    it('should handle zero TimeSpan', () => {
      expect(TimeSpan.ZERO.toString()).to.equal('00:00:00');
    });
  });

  describe('Parse Method', () => {
    it('should parse TimeSpan instance', () => {
      const original = TimeSpan.fromHours(2);
      const parsed = TimeSpan.parse(original)!;
      expect(parsed).to.equal(original);
    });

    it('should parse Date object', () => {
      const date = new Date(Date.now() - 5000);
      const parsed = TimeSpan.parse(date)!;
      expect(parsed.totalMilliseconds).to.be.approximately(5000, 100);
    });

    it('should return null for falsy values', () => {
      expect(TimeSpan.parse(null as any)).to.be.null;
      expect(TimeSpan.parse(undefined as any)).to.be.null;
      expect(TimeSpan.parse(0)).to.not.be.null; // 0 is valid
    });

    it('should parse object with time components', () => {
      const parsed = TimeSpan.parse({
        days: 1,
        hours: 2,
        minutes: 30,
        seconds: 45,
        milliseconds: 123
      })!;

      expect(parsed.days).to.equal(1);
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
      expect(parsed.milliseconds).to.equal(123);
    });

    it('should throw error for invalid string format', () => {
      // a single token ( no ':' ) cannot be a "[d.]hh:mm[:ss[.fff]]" span
      expect(() => TimeSpan.parse('invalid')).to.throw('Invalid TimeSpan format');
      expect(() => TimeSpan.parse('12')).to.throw('Invalid TimeSpan format');
    });

    it('should parse the two-token hh:mm format', () => {
      const parsed = TimeSpan.parse('12:34')!;
      expect(parsed.hours).to.equal(12);
      expect(parsed.minutes).to.equal(34);
      expect(parsed.seconds).to.equal(0);
    });

    it('should handle milliseconds with different lengths', () => {
      const parsed1 = TimeSpan.parse('12:34:56.1')!;
      expect(parsed1.milliseconds).to.equal(100);

      const parsed2 = TimeSpan.parse('12:34:56.12')!;
      expect(parsed2.milliseconds).to.equal(120);

      const parsed3 = TimeSpan.parse('12:34:56.1234')!;
      expect(parsed3.milliseconds).to.equal(123);
    });
  });

  describe('Round-trip String Conversion', () => {

    it('should parse and toString consistently (negative)', () => {
      expect(TimeSpan.parse('-01:30:00')!.totalMinutes).to.equal(-90);
      expect(TimeSpan.parse('-1.02:30:45.123')!.toString()).to.equal('-1.02:30:45.123');
    });
  });

  describe('Edge Cases and Error Handling', () => {

    it('should throw error for NaN', () => {
      expect(() => TimeSpan.fromHours(NaN)).to.throw("value is NaN");
    });

    it('should throw error for values exceeding MAX_VALUE', () => {
      expect(() => TimeSpan.fromTime(
        Number.MAX_SAFE_INTEGER, 0, 0, 0, 0
      )).to.throw('TimeSpanTooLong');
    });

    it('rejects a span past either bound with TimeSpanTooLong', () => {
      expect(() => TimeSpan.fromMilliseconds(Number.MAX_SAFE_INTEGER + 2)).to.throw('TimeSpanTooLong');
      expect(() => TimeSpan.fromMilliseconds(Number.MIN_SAFE_INTEGER - 2)).to.throw('TimeSpanTooLong');
    });

    it('rounds a fraction half away from zero, negative ones included', () => {
      expect(TimeSpan.fromMilliseconds(1.2).totalMilliseconds).to.equal(1);
      expect(TimeSpan.fromMilliseconds(1.7).totalMilliseconds).to.equal(2);
      expect(TimeSpan.fromMilliseconds(-1.2).totalMilliseconds).to.equal(-1);
      expect(TimeSpan.fromMilliseconds(-1.7).totalMilliseconds).to.equal(-2);
    });
  });

  describe('Date and DateTime Integration', () => {
    describe('fromDate', () => {
      it('should create TimeSpan from past date', () => {
        const pastDate = new Date(Date.now() - 5000); // 5 seconds ago
        const ts = TimeSpan.fromDate(pastDate);
        
        expect(ts.totalMilliseconds).to.be.approximately(5000, 100);
      });
    });

    describe('fromDateTime', () => {
      it('should create TimeSpan from past DateTime', () => {
        const pastDateTime = DateTime.now().minus({ seconds: 10 });
        const ts = TimeSpan.fromDateTime(pastDateTime);
        
        expect(ts.totalMilliseconds).to.be.approximately(10000, 100);
      });
    });

    describe('Round-trip conversions', () => {
      it('should round-trip Date -> TimeSpan -> Date', () => {
        const originalDate = new Date('2023-01-01T12:00:00');
        const ts = TimeSpan.fromDays(5);
        const newDate = ts.toDate(originalDate);
        const tsBack = TimeSpan.between(newDate, originalDate);
        
        expect(tsBack.totalDays).to.be.approximately(5, 0.001);
      });

      it('should round-trip DateTime -> TimeSpan -> DateTime', () => {
        const originalDateTime = DateTime.fromISO('2023-01-01T12:00:00');
        const ts = TimeSpan.fromHours(48);
        const newDateTime = ts.toDateTime(originalDateTime);
        const tsBack = TimeSpan.between(newDateTime, originalDateTime);
        
        expect(tsBack.totalHours).to.be.approximately(48, 0.001);
      });
    });
  });

  describe('Static TIMEZONE_OFFSET', () => {
    it('returns a TimeSpan matching the local UTC offset', () => {
      // The getter caches: an earlier read would hide how the value is computed.
      (TimeSpan as unknown as { _TIMEZONE_OFFSET?: TimeSpan })._TIMEZONE_OFFSET = undefined;
      const offset = TimeSpan.TIMEZONE_OFFSET;
      expect(offset).to.be.instanceOf(TimeSpan);
      // JS getTimezoneOffset() is in minutes and inverted vs. the usual sign convention
      expect(offset.totalMinutes).to.equal(-new Date().getTimezoneOffset());
    });
  });
});

