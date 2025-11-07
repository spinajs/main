import { expect } from 'chai';
import { TimeSpan } from '../src/timespan.js';
import { DateTime } from 'luxon';
import 'mocha';

describe('TimeSpan', () => {
  describe('Constructor and Constants', () => {
    it('should create TimeSpan from milliseconds', () => {
      const ts = new TimeSpan(5000);
      expect(ts.totalMilliseconds).to.equal(5000);
    });

    it('should have correct constant values', () => {
      expect(TimeSpan.MILLIS_PER_SECOND).to.equal(1000);
      expect(TimeSpan.MILLIS_PER_MINUTE).to.equal(60000);
      expect(TimeSpan.MILLIS_PER_HOUR).to.equal(3600000);
      expect(TimeSpan.MILLIS_PER_DAY).to.equal(86400000);
    });

    it('should have ZERO constant', () => {
      expect(TimeSpan.ZERO.totalMilliseconds).to.equal(0);
    });

    it('should have MAX_VALUE and MIN_VALUE constants', () => {
      expect(TimeSpan.MAX_VALUE.totalMilliseconds).to.equal(Number.MAX_SAFE_INTEGER);
      expect(TimeSpan.MIN_VALUE.totalMilliseconds).to.equal(Number.MIN_SAFE_INTEGER);
    });
  });

  describe('Property Getters', () => {
    it('should get milliseconds component', () => {
      const ts = new TimeSpan(1234);
      expect(ts.milliseconds).to.equal(234);
    });

    it('should get seconds component', () => {
      const ts = TimeSpan.fromSeconds(65);
      expect(ts.seconds).to.equal(5);
    });

    it('should get minutes component', () => {
      const ts = TimeSpan.fromMinutes(75);
      expect(ts.minutes).to.equal(15);
    });

    it('should get hours component', () => {
      const ts = TimeSpan.fromHours(26);
      expect(ts.hours).to.equal(2);
    });

    it('should get days component', () => {
      const ts = TimeSpan.fromDays(5);
      expect(ts.days).to.equal(5);
    });

    it('should get total milliseconds', () => {
      const ts = new TimeSpan(12345);
      expect(ts.totalMilliseconds).to.equal(12345);
    });

    it('should get total seconds', () => {
      const ts = TimeSpan.fromSeconds(90);
      expect(ts.totalSeconds).to.equal(90);
    });

    it('should get total minutes', () => {
      const ts = TimeSpan.fromMinutes(150);
      expect(ts.totalMinutes).to.equal(150);
    });

    it('should get total hours', () => {
      const ts = TimeSpan.fromHours(36);
      expect(ts.totalHours).to.equal(36);
    });

    it('should get total days', () => {
      const ts = TimeSpan.fromDays(7);
      expect(ts.totalDays).to.equal(7);
    });
  });

  describe('Static Factory Methods', () => {
    it('should create from days', () => {
      const ts = TimeSpan.fromDays(2);
      expect(ts.totalDays).to.equal(2);
      expect(ts.totalHours).to.equal(48);
    });

    it('should create from hours', () => {
      const ts = TimeSpan.fromHours(3);
      expect(ts.totalHours).to.equal(3);
      expect(ts.totalMinutes).to.equal(180);
    });

    it('should create from minutes', () => {
      const ts = TimeSpan.fromMinutes(120);
      expect(ts.totalMinutes).to.equal(120);
      expect(ts.totalHours).to.equal(2);
    });

    it('should create from seconds', () => {
      const ts = TimeSpan.fromSeconds(3600);
      expect(ts.totalSeconds).to.equal(3600);
      expect(ts.totalHours).to.equal(1);
    });

    it('should create from milliseconds', () => {
      const ts = TimeSpan.fromMilliseconds(5000);
      expect(ts.totalMilliseconds).to.equal(5000);
      expect(ts.totalSeconds).to.equal(5);
    });

    it('should create from time (hours, minutes, seconds)', () => {
      const ts = TimeSpan.fromTime(2, 30, 45);
      expect(ts.hours).to.equal(2);
      expect(ts.minutes).to.equal(30);
      expect(ts.seconds).to.equal(45);
    });

    it('should create from time (days, hours, minutes, seconds, milliseconds)', () => {
      const ts = TimeSpan.fromTime(1, 2, 30, 45, 500);
      expect(ts.days).to.equal(1);
      expect(ts.hours).to.equal(2);
      expect(ts.minutes).to.equal(30);
      expect(ts.seconds).to.equal(45);
      expect(ts.milliseconds).to.equal(500);
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
      it('should check if time is in range (normal hours)', () => {
        const timeSpan = TimeSpan.fromTime(15, 30, 0); // 3:30 PM
        const startDate = new Date('2023-01-01T14:00:00Z'); // 2:00 PM
        const endDate = new Date('2023-01-01T17:00:00Z');   // 5:00 PM
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.true;
      });

      it('should return false if time is before range', () => {
        const timeSpan = TimeSpan.fromTime(10, 0, 0); // 10:00 AM
        const startDate = new Date('2023-01-01T14:00:00Z'); // 2:00 PM
        const endDate = new Date('2023-01-01T17:00:00Z');   // 5:00 PM
        
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.false;
      });

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

      it('should handle TimeSpan with days component', () => {
        const timeSpan = TimeSpan.fromTime(2, 15, 30, 0, 0); // 2 days + 15:30:00
        const startDate = new Date('2023-01-01T14:00:00Z'); // 2:00 PM
        const endDate = new Date('2023-01-01T17:00:00Z');   // 5:00 PM
        
        // Should check only the time-of-day part (15:30)
        expect(timeSpan.isTimeInRange(startDate, endDate)).to.be.true;
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
      it('should check if time is in range (normal hours)', () => {
        const timeSpan = TimeSpan.fromTime(15, 30, 0); // 3:30 PM
        const startDateTime = DateTime.fromISO('2023-01-01T14:00:00');
        const endDateTime = DateTime.fromISO('2023-01-01T17:00:00');
        
        expect(timeSpan.isTimeInRange(startDateTime, endDateTime)).to.be.true;
      });

      it('should return false if time is before range', () => {
        const timeSpan = TimeSpan.fromTime(10, 0, 0);
        const startDateTime = DateTime.fromISO('2023-01-01T14:00:00');
        const endDateTime = DateTime.fromISO('2023-01-01T17:00:00');
        
        expect(timeSpan.isTimeInRange(startDateTime, endDateTime)).to.be.false;
      });

      it('should handle range crossing midnight with DateTime', () => {
        const timeSpan = TimeSpan.fromTime(23, 30, 0);
        const startDateTime = DateTime.fromISO('2023-01-01T22:00:00');
        const endDateTime = DateTime.fromISO('2023-01-01T02:00:00');
        
        expect(timeSpan.isTimeInRange(startDateTime, endDateTime)).to.be.true;
      });

      it('should handle time with timezone', () => {
        const timeSpan = TimeSpan.fromTime(15, 30, 0);
        const startDateTime = DateTime.fromISO('2023-01-01T14:00:00', { zone: 'America/New_York' });
        const endDateTime = DateTime.fromISO('2023-01-01T17:00:00', { zone: 'America/New_York' });
        
        expect(timeSpan.isTimeInRange(startDateTime, endDateTime)).to.be.true;
      });
    });

    describe('isBetween with TimeSpan', () => {
      it('should check if time is between two TimeSpans (normal range)', () => {
        const time = TimeSpan.fromTime(15, 30, 0); // 3:30 PM
        const start = TimeSpan.fromTime(14, 0, 0); // 2:00 PM
        const end = TimeSpan.fromTime(17, 0, 0);   // 5:00 PM
        
        expect(time.isBetween(start, end)).to.be.true;
      });

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

      it('should handle TimeSpan with days component', () => {
        const time = TimeSpan.fromTime(2, 15, 30, 0, 0); // 2 days + 15:30
        const start = TimeSpan.fromTime(14, 0, 0);
        const end = TimeSpan.fromTime(17, 0, 0);
        
        // Should normalize to time-of-day (15:30)
        expect(time.isBetween(start, end)).to.be.true;
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

      it('should handle midnight boundary', () => {
        const time = TimeSpan.fromTime(0, 0, 0); // Midnight
        const start = TimeSpan.fromTime(22, 0, 0);
        const end = TimeSpan.fromTime(2, 0, 0);
        
        expect(time.isBetween(start, end)).to.be.true;
      });
    });
  });

  describe('Utility Methods', () => {
    it('should negate TimeSpan', () => {
      const ts = TimeSpan.fromHours(5);
      const negated = ts.negate();
      expect(negated.totalHours).to.equal(-5);
    });

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
    it('should convert to string (hours:minutes:seconds)', () => {
      const ts = TimeSpan.fromTime(2, 30, 45);
      expect(ts.toString()).to.equal('02:30:45');
    });

    it('should convert to string with days', () => {
      const ts = TimeSpan.fromTime(1, 2, 30, 45, 0);
      expect(ts.toString()).to.equal('1.02:30:45');
    });

    it('should convert to string with milliseconds', () => {
      const ts = TimeSpan.fromTime(0, 2, 30, 45, 123);
      expect(ts.toString()).to.equal('02:30:45.123');
    });

    it('should convert to string with days and milliseconds', () => {
      const ts = TimeSpan.fromTime(1, 2, 30, 45, 123);
      expect(ts.toString()).to.equal('1.02:30:45.123');
    });

    it('should convert negative TimeSpan to string', () => {
      const ts = TimeSpan.fromHours(-2);
      expect(ts.toString()).to.equal('-02:00:00');
    });

    it('should handle zero TimeSpan', () => {
      expect(TimeSpan.ZERO.toString()).to.equal('00:00:00');
    });
  });

  describe('Parse Method', () => {
    it('should parse TimeSpan instance', () => {
      const original = TimeSpan.fromHours(2);
      const parsed = TimeSpan.parse(original);
      expect(parsed).to.equal(original);
    });

    it('should parse number as milliseconds', () => {
      const parsed = TimeSpan.parse(5000);
      expect(parsed.totalMilliseconds).to.equal(5000);
    });

    it('should parse Date object', () => {
      const date = new Date(Date.now() - 5000);
      const parsed = TimeSpan.parse(date);
      expect(parsed.totalMilliseconds).to.be.approximately(5000, 100);
    });

    it('should return null for falsy values', () => {
      expect(TimeSpan.parse(null)).to.be.null;
      expect(TimeSpan.parse(undefined)).to.be.null;
      expect(TimeSpan.parse(0)).to.not.be.null; // 0 is valid
    });

    it('should parse object with time components', () => {
      const parsed = TimeSpan.parse({
        days: 1,
        hours: 2,
        minutes: 30,
        seconds: 45,
        milliseconds: 123
      });
      
      expect(parsed.days).to.equal(1);
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
      expect(parsed.milliseconds).to.equal(123);
    });

    it('should parse string format hh:mm:ss', () => {
      const parsed = TimeSpan.parse('02:30:45');
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
    });

    it('should parse string format d.hh:mm:ss', () => {
      const parsed = TimeSpan.parse('1.02:30:45');
      expect(parsed.days).to.equal(1);
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
    });

    it('should parse string format hh:mm:ss.fff', () => {
      const parsed = TimeSpan.parse('02:30:45.123');
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
      expect(parsed.milliseconds).to.equal(123);
    });

    it('should parse string format d.hh:mm:ss.fff', () => {
      const parsed = TimeSpan.parse('1.02:30:45.123');
      expect(parsed.days).to.equal(1);
      expect(parsed.hours).to.equal(2);
      expect(parsed.minutes).to.equal(30);
      expect(parsed.seconds).to.equal(45);
      expect(parsed.milliseconds).to.equal(123);
    });

    it('should throw error for invalid string format', () => {
      expect(() => TimeSpan.parse('invalid')).to.throw('Invalid TimeSpan format');
      expect(() => TimeSpan.parse('12:34')).to.throw('Invalid TimeSpan format');
    });

    it('should handle milliseconds with different lengths', () => {
      const parsed1 = TimeSpan.parse('12:34:56.1');
      expect(parsed1.milliseconds).to.equal(100);

      const parsed2 = TimeSpan.parse('12:34:56.12');
      expect(parsed2.milliseconds).to.equal(120);

      const parsed3 = TimeSpan.parse('12:34:56.1234');
      expect(parsed3.milliseconds).to.equal(123);
    });
  });

  describe('Round-trip String Conversion', () => {
    it('should parse and toString consistently (simple)', () => {
      const original = '02:30:45';
      const parsed = TimeSpan.parse(original);
      expect(parsed.toString()).to.equal(original);
    });

    it('should parse and toString consistently (with days)', () => {
      const original = '1.02:30:45';
      const parsed = TimeSpan.parse(original);
      expect(parsed.toString()).to.equal(original);
    });

    it('should parse and toString consistently (with milliseconds)', () => {
      const original = '02:30:45.123';
      const parsed = TimeSpan.parse(original);
      expect(parsed.toString()).to.equal(original);
    });

    it('should parse and toString consistently (complete)', () => {
      const original = '1.02:30:45.123';
      const parsed = TimeSpan.parse(original);
      expect(parsed.toString()).to.equal(original);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle negative values', () => {
      const ts = TimeSpan.fromHours(-5);
      expect(ts.totalHours).to.equal(-5);
      expect(ts.hours).to.equal(-5);
    });

    it('should throw error for NaN', () => {
      expect(() => TimeSpan.fromHours(NaN)).to.throw("value is NaN");
    });

    it('should throw error for values exceeding MAX_VALUE', () => {
      expect(() => TimeSpan.fromTime(
        Number.MAX_SAFE_INTEGER, 0, 0, 0, 0
      )).to.throw('TimeSpanTooLong');
    });

    it('should handle zero correctly', () => {
      const ts = TimeSpan.fromMilliseconds(0);
      expect(ts.totalMilliseconds).to.equal(0);
      expect(ts.days).to.equal(0);
      expect(ts.hours).to.equal(0);
      expect(ts.minutes).to.equal(0);
      expect(ts.seconds).to.equal(0);
      expect(ts.milliseconds).to.equal(0);
    });

    it('should handle large values within safe range', () => {
      const days = 1000000;
      const ts = TimeSpan.fromDays(days);
      expect(ts.totalDays).to.equal(days);
    });
  });

  describe('Immutability', () => {
    it('should not mutate original TimeSpan when adding', () => {
      const original = TimeSpan.fromHours(2);
      const result = original.addHours(3);
      
      expect(original.totalHours).to.equal(2);
      expect(result.totalHours).to.equal(5);
    });

    it('should not mutate original TimeSpan when subtracting', () => {
      const original = TimeSpan.fromHours(5);
      const result = original.subtractHours(2);
      
      expect(original.totalHours).to.equal(5);
      expect(result.totalHours).to.equal(3);
    });

    it('should not mutate original TimeSpan when negating', () => {
      const original = TimeSpan.fromHours(5);
      const result = original.negate();
      
      expect(original.totalHours).to.equal(5);
      expect(result.totalHours).to.equal(-5);
    });

    it('should not mutate original TimeSpan when getting abs', () => {
      const original = TimeSpan.fromHours(-5);
      const result = original.abs();
      
      expect(original.totalHours).to.equal(-5);
      expect(result.totalHours).to.equal(5);
    });
  });

  describe('Date and DateTime Integration', () => {
    describe('fromDate', () => {
      it('should create TimeSpan from past date', () => {
        const pastDate = new Date(Date.now() - 5000); // 5 seconds ago
        const ts = TimeSpan.fromDate(pastDate);
        
        expect(ts.totalMilliseconds).to.be.approximately(5000, 100);
      });

      it('should create negative TimeSpan from future date', () => {
        const futureDate = new Date(Date.now() + 5000); // 5 seconds from now
        const ts = TimeSpan.fromDate(futureDate);
        
        expect(ts.totalMilliseconds).to.be.approximately(-5000, 100);
      });

      it('should handle distant past dates', () => {
        const pastDate = new Date('2020-01-01');
        const ts = TimeSpan.fromDate(pastDate);
        
        expect(ts.totalMilliseconds).to.be.greaterThan(0);
        expect(ts.totalDays).to.be.greaterThan(1000);
      });
    });

    describe('fromDateTime', () => {
      it('should create TimeSpan from past DateTime', () => {
        const pastDateTime = DateTime.now().minus({ seconds: 10 });
        const ts = TimeSpan.fromDateTime(pastDateTime);
        
        expect(ts.totalMilliseconds).to.be.approximately(10000, 100);
      });

      it('should create negative TimeSpan from future DateTime', () => {
        const futureDateTime = DateTime.now().plus({ hours: 1 });
        const ts = TimeSpan.fromDateTime(futureDateTime);
        
        expect(ts.totalMilliseconds).to.be.approximately(-3600000, 100);
      });

      it('should handle DateTime with different time zones', () => {
        const utcTime = DateTime.utc();
        const ts = TimeSpan.fromDateTime(utcTime);
        
        expect(ts.totalMilliseconds).to.be.approximately(0, 100);
      });
    });

    describe('between', () => {
      it('should calculate difference between two Date objects', () => {
        const date1 = new Date('2023-01-02');
        const date2 = new Date('2023-01-01');
        const ts = TimeSpan.between(date1, date2);
        
        expect(ts.totalDays).to.equal(1);
      });

      it('should calculate difference between two DateTime objects', () => {
        const dt1 = DateTime.fromISO('2023-01-02T12:00:00');
        const dt2 = DateTime.fromISO('2023-01-01T12:00:00');
        const ts = TimeSpan.between(dt1, dt2);
        
        expect(ts.totalDays).to.equal(1);
      });

      it('should return negative TimeSpan when date1 < date2', () => {
        const date1 = new Date('2023-01-01');
        const date2 = new Date('2023-01-02');
        const ts = TimeSpan.between(date1, date2);
        
        expect(ts.totalDays).to.equal(-1);
      });

      it('should handle same dates returning zero TimeSpan', () => {
        const date = new Date('2023-01-01');
        const ts = TimeSpan.between(date, date);
        
        expect(ts.totalMilliseconds).to.equal(0);
      });

      it('should calculate complex time differences', () => {
        const dt1 = DateTime.fromISO('2023-01-01T15:30:45.123');
        const dt2 = DateTime.fromISO('2023-01-01T12:15:30.100');
        const ts = TimeSpan.between(dt1, dt2);
        
        expect(ts.hours).to.equal(3);
        expect(ts.minutes).to.equal(15);
        expect(ts.seconds).to.equal(15);
        expect(ts.milliseconds).to.equal(23);
      });
    });

    describe('toDate', () => {
      it('should convert TimeSpan to Date from current time', () => {
        const ts = TimeSpan.fromHours(2);
        const resultDate = ts.toDate();
        const expectedTime = Date.now() + 2 * 60 * 60 * 1000;
        
        expect(resultDate.getTime()).to.be.approximately(expectedTime, 100);
      });

      it('should convert TimeSpan to Date from base date', () => {
        const baseDate = new Date('2023-01-01T00:00:00Z');
        const ts = TimeSpan.fromDays(1);
        const resultDate = ts.toDate(baseDate);
        
        expect(resultDate.toISOString()).to.include('2023-01-02');
      });

      it('should handle negative TimeSpan', () => {
        const baseDate = new Date('2023-01-02T00:00:00Z');
        const ts = TimeSpan.fromDays(-1);
        const resultDate = ts.toDate(baseDate);
        
        expect(resultDate.toISOString()).to.include('2023-01-01');
      });

      it('should add complex TimeSpan to base date', () => {
        const baseDate = new Date('2023-01-01T12:00:00');
        const ts = TimeSpan.fromTime(1, 2, 30, 45, 500); // 1d 2h 30m 45s 500ms
        const resultDate = ts.toDate(baseDate);
        
        const expected = new Date('2023-01-02T14:30:45.500');
        expect(Math.abs(resultDate.getTime() - expected.getTime())).to.be.lessThan(100);
      });
    });

    describe('toDateTime', () => {
      it('should convert TimeSpan to DateTime from current time', () => {
        const ts = TimeSpan.fromHours(3);
        const resultDateTime = ts.toDateTime();
        const expectedDateTime = DateTime.now().plus({ hours: 3 });
        
        expect(Math.abs(resultDateTime.toMillis() - expectedDateTime.toMillis())).to.be.lessThan(100);
      });

      it('should convert TimeSpan to DateTime from base DateTime', () => {
        const baseDateTime = DateTime.fromISO('2023-01-01T00:00:00');
        const ts = TimeSpan.fromDays(1);
        const resultDateTime = ts.toDateTime(baseDateTime);
        
        expect(resultDateTime.toISO()).to.include('2023-01-02');
      });

      it('should handle negative TimeSpan with DateTime', () => {
        const baseDateTime = DateTime.fromISO('2023-01-02T00:00:00');
        const ts = TimeSpan.fromDays(-1);
        const resultDateTime = ts.toDateTime(baseDateTime);
        
        expect(resultDateTime.toISO()).to.include('2023-01-01');
      });

      it('should preserve time zone when adding TimeSpan', () => {
        const baseDateTime = DateTime.fromISO('2023-01-01T12:00:00', { zone: 'America/New_York' });
        const ts = TimeSpan.fromHours(5);
        const resultDateTime = ts.toDateTime(baseDateTime);
        
        expect(resultDateTime.zoneName).to.equal('America/New_York');
        expect(resultDateTime.hour).to.equal(17);
      });

      it('should add complex TimeSpan to base DateTime', () => {
        const baseDateTime = DateTime.fromISO('2023-01-01T12:00:00.000');
        const ts = TimeSpan.fromTime(1, 2, 30, 45, 500); // 1d 2h 30m 45s 500ms
        const resultDateTime = ts.toDateTime(baseDateTime);
        
        expect(resultDateTime.day).to.equal(2);
        expect(resultDateTime.hour).to.equal(14);
        expect(resultDateTime.minute).to.equal(30);
        expect(resultDateTime.second).to.equal(45);
        expect(resultDateTime.millisecond).to.equal(500);
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

      it('should handle Date/DateTime interoperability', () => {
        const date = new Date('2023-01-01T00:00:00Z');
        const dateTime = DateTime.fromJSDate(date);
        
        const tsFromDate = TimeSpan.between(new Date('2023-01-02T00:00:00Z'), date);
        const tsFromDateTime = TimeSpan.between(dateTime.plus({ days: 1 }), dateTime);
        
        expect(tsFromDate.totalDays).to.be.approximately(tsFromDateTime.totalDays, 0.001);
      });
    });
  });
});

