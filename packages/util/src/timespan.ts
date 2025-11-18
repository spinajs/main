import { DateTime } from 'luxon';
import { _is_number, _non_NaN, _between } from './args.js';

export interface TimeLike {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

export type TimeSpanLike = number | string | TimeLike | TimeSpan;


export class TimeSpan {
  public static readonly MILLIS_PER_SECOND = 1000;
  public static readonly MILLIS_PER_MINUTE = TimeSpan.MILLIS_PER_SECOND * 60;
  public static readonly MILLIS_PER_HOUR = TimeSpan.MILLIS_PER_MINUTE * 60;
  public static readonly MILLIS_PER_DAY = TimeSpan.MILLIS_PER_HOUR * 24;

  public static readonly ZERO = new TimeSpan(0);
  public static readonly MAX_VALUE = new TimeSpan(Number.MAX_SAFE_INTEGER);
  public static readonly MIN_VALUE = new TimeSpan(Number.MIN_SAFE_INTEGER);

  private static _TIMEZONE_OFFSET: TimeSpan;
  public static get TIMEZONE_OFFSET() {
    if (!this._TIMEZONE_OFFSET) {
      this._TIMEZONE_OFFSET = TimeSpan.fromMinutes(
        new Date().getTimezoneOffset() * -1,
      );
    }

    return TimeSpan._TIMEZONE_OFFSET;
  }

  private readonly _millis: number;

  constructor(millis: number) {
    this._millis = millis;
  }

  public get milliseconds(): number {
    return TimeSpan.round(this._millis % 1000);
  }

  public get seconds(): number {
    return TimeSpan.round((this._millis / TimeSpan.MILLIS_PER_SECOND) % 60);
  }

  public get minutes(): number {
    return TimeSpan.round((this._millis / TimeSpan.MILLIS_PER_MINUTE) % 60);
  }

  public get hours(): number {
    return TimeSpan.round((this._millis / TimeSpan.MILLIS_PER_HOUR) % 24);
  }

  public get days(): number {
    return TimeSpan.round(this._millis / TimeSpan.MILLIS_PER_DAY);
  }

  public get totalDays(): number {
    return this._millis / TimeSpan.MILLIS_PER_DAY;
  }

  public get totalHours(): number {
    return this._millis / TimeSpan.MILLIS_PER_HOUR;
  }

  public get totalMinutes(): number {
    return this._millis / TimeSpan.MILLIS_PER_MINUTE;
  }

  public get totalSeconds(): number {
    return this._millis / TimeSpan.MILLIS_PER_SECOND;
  }

  public get totalMilliseconds(): number {
    return this._millis;
  }

  public add(ts: TimeSpan): TimeSpan {
    const result = this._millis + ts.totalMilliseconds;
    return new TimeSpan(result);
  }

  public subtract(ts: TimeSpan): TimeSpan {
    const result = this._millis - ts.totalMilliseconds;
    return new TimeSpan(result);
  }

  public addDays(value: number): TimeSpan {
    const result = this._millis + value * TimeSpan.MILLIS_PER_DAY;
    return new TimeSpan(result);
  }

  public subtractDays(value: number): TimeSpan {
    const result = this._millis - value * TimeSpan.MILLIS_PER_DAY;
    return new TimeSpan(result);
  }

  public addHours(value: number): TimeSpan {
    const result = this._millis + value * TimeSpan.MILLIS_PER_HOUR;
    return new TimeSpan(result);
  }

  public subtractHours(value: number): TimeSpan {
    const result = this._millis - value * TimeSpan.MILLIS_PER_HOUR;
    return new TimeSpan(result);
  }

  public addMinutes(value: number): TimeSpan {
    const result = this._millis + value * TimeSpan.MILLIS_PER_MINUTE;
    return new TimeSpan(result);
  }

  public subtractMinutes(value: number): TimeSpan {
    const result = this._millis - value * TimeSpan.MILLIS_PER_MINUTE;
    return new TimeSpan(result);
  }

  public addSeconds(value: number): TimeSpan {
    const result = this._millis + value * TimeSpan.MILLIS_PER_SECOND;
    return new TimeSpan(result);
  }

  public addMilliseconds(value: number): TimeSpan {
    const result = this._millis + value;
    return new TimeSpan(result);
  }

  public subtractSeconds(value: number): TimeSpan {
    const result = this._millis - value * TimeSpan.MILLIS_PER_SECOND;
    return new TimeSpan(result);
  }

  public subtractMilliseconds(value: number): TimeSpan {
    const result = this._millis - value;
    return new TimeSpan(result);
  }

  public negate(): TimeSpan {
    return new TimeSpan(-this._millis);
  }

  public equals(value?: any): boolean {
    if (value instanceof TimeSpan) {
      return this._millis === value._millis;
    }

    return false;
  }

  /**
   * Compares this TimeSpan with another TimeSpan
   * @returns -1 if this < other, 0 if equal, 1 if this > other
   */
  public compareTo(other: TimeSpan): number {
    if (this._millis < other._millis) return -1;
    if (this._millis > other._millis) return 1;
    return 0;
  }

  /**
   * Checks if this TimeSpan is greater than another
   */
  public greaterThan(other: TimeSpan): boolean {
    return this._millis > other._millis;
  }

  /**
   * Checks if this TimeSpan is greater than or equal to another
   */
  public greaterThanOrEqual(other: TimeSpan): boolean {
    return this._millis >= other._millis;
  }

  /**
   * Checks if this TimeSpan is less than another
   */
  public lessThan(other: TimeSpan): boolean {
    return this._millis < other._millis;
  }

  /**
   * Checks if this TimeSpan is less than or equal to another
   */
  public lessThanOrEqual(other: TimeSpan): boolean {
    return this._millis <= other._millis;
  }

  /**
   * Checks if the time-of-day represented by this TimeSpan falls within a date range
   * This treats the TimeSpan as hours:minutes:seconds from midnight
   * @param startDate - The start of the date range
   * @param endDate - The end of the date range
   * @returns true if the time-of-day is within the range on any day in the range
   */
  public isTimeInRange(startDate: Date, endDate: Date): boolean;
  public isTimeInRange(startDateTime: DateTime, endDateTime: DateTime): boolean;
  public isTimeInRange(start: Date | DateTime, end: Date | DateTime): boolean {
    let startTime: number;
    let endTime: number;

    if (start instanceof Date) {
      // Extract time-of-day in milliseconds since midnight
      const startHours = start.getHours();
      const startMinutes = start.getMinutes();
      const startSeconds = start.getSeconds();
      const startMs = start.getMilliseconds();
      startTime = startHours * TimeSpan.MILLIS_PER_HOUR + 
                  startMinutes * TimeSpan.MILLIS_PER_MINUTE + 
                  startSeconds * TimeSpan.MILLIS_PER_SECOND + 
                  startMs;
    } else {
      // Luxon DateTime
      startTime = start.hour * TimeSpan.MILLIS_PER_HOUR + 
                  start.minute * TimeSpan.MILLIS_PER_MINUTE + 
                  start.second * TimeSpan.MILLIS_PER_SECOND + 
                  start.millisecond;
    }

    if (end instanceof Date) {
      const endHours = end.getHours();
      const endMinutes = end.getMinutes();
      const endSeconds = end.getSeconds();
      const endMs = end.getMilliseconds();
      endTime = endHours * TimeSpan.MILLIS_PER_HOUR + 
                endMinutes * TimeSpan.MILLIS_PER_MINUTE + 
                endSeconds * TimeSpan.MILLIS_PER_SECOND + 
                endMs;
    } else {
      endTime = end.hour * TimeSpan.MILLIS_PER_HOUR + 
                end.minute * TimeSpan.MILLIS_PER_MINUTE + 
                end.second * TimeSpan.MILLIS_PER_SECOND + 
                end.millisecond;
    }

    // Normalize this TimeSpan to a time-of-day (remove days component)
    const thisTimeOfDay = this._millis % TimeSpan.MILLIS_PER_DAY;
    const normalizedTime = thisTimeOfDay >= 0 ? thisTimeOfDay : thisTimeOfDay + TimeSpan.MILLIS_PER_DAY;

    // Check if the time falls within the range
    if (startTime <= endTime) {
      // Normal case: range doesn't cross midnight
      return normalizedTime >= startTime && normalizedTime <= endTime;
    } else {
      // Range crosses midnight (e.g., 22:00 to 02:00)
      return normalizedTime >= startTime || normalizedTime <= endTime;
    }
  }

  /**
   * Checks if this TimeSpan (as a time-of-day) falls between two times
   * @param startTime - Start time as TimeSpan
   * @param endTime - End time as TimeSpan
   * @returns true if this time is within the range
   */
  public isBetween(startTime: TimeSpan, endTime: TimeSpan): boolean {
    // Normalize all timespans to time-of-day (0-24 hours)
    const thisTimeOfDay = this._millis % TimeSpan.MILLIS_PER_DAY;
    const normalizedThis = thisTimeOfDay >= 0 ? thisTimeOfDay : thisTimeOfDay + TimeSpan.MILLIS_PER_DAY;

    const startTimeOfDay = startTime._millis % TimeSpan.MILLIS_PER_DAY;
    const normalizedStart = startTimeOfDay >= 0 ? startTimeOfDay : startTimeOfDay + TimeSpan.MILLIS_PER_DAY;

    const endTimeOfDay = endTime._millis % TimeSpan.MILLIS_PER_DAY;
    const normalizedEnd = endTimeOfDay >= 0 ? endTimeOfDay : endTimeOfDay + TimeSpan.MILLIS_PER_DAY;

    if (normalizedStart <= normalizedEnd) {
      // Normal case: range doesn't cross midnight
      return normalizedThis >= normalizedStart && normalizedThis <= normalizedEnd;
    } else {
      // Range crosses midnight (e.g., 22:00 to 02:00)
      return normalizedThis >= normalizedStart || normalizedThis <= normalizedEnd;
    }
  }

  /**
   * Returns the absolute value of this TimeSpan
   */
  public abs(): TimeSpan {
    return this._millis < 0 ? new TimeSpan(-this._millis) : this;
  }

  /**
   * Multiplies the TimeSpan by a factor
   */
  public multiply(factor: number): TimeSpan {
    factor = _is_number(_non_NaN())(factor, 'factor');
    return new TimeSpan(this._millis * factor);
  }

  /**
   * Divides the TimeSpan by a divisor
   */
  public divide(divisor: number): TimeSpan {
    divisor = _is_number(_non_NaN())(divisor, 'divisor');
    if (divisor === 0) {
      throw new Error('Cannot divide TimeSpan by zero');
    }
    return new TimeSpan(this._millis / divisor);
  }

  /**
   * Returns the duration (absolute value) of this TimeSpan
   */
  public duration(): TimeSpan {
    return this.abs();
  }

  /**
   * Converts TimeSpan to a plain object
   */
  public toObject(): TimeLike {
    return {
      days: this.days,
      hours: this.hours,
      minutes: this.minutes,
      seconds: this.seconds,
      milliseconds: this.milliseconds,
    };
  }

  /**
   * Converts this TimeSpan to a JavaScript Date
   * @param baseDate - Optional base date to add the TimeSpan to. Defaults to current time.
   * @returns A Date representing baseDate + this TimeSpan
   */
  public toDate(baseDate?: Date): Date {
    const base = baseDate ? baseDate.getTime() : Date.now();
    return new Date(base + this._millis);
  }

  /**
   * Converts this TimeSpan to a Luxon DateTime
   * @param baseDateTime - Optional base DateTime to add the TimeSpan to. Defaults to current time.
   * @returns A DateTime representing baseDateTime + this TimeSpan
   */
  public toDateTime(baseDateTime?: DateTime): DateTime {
    const base = baseDateTime || DateTime.now();
    return base.plus({ milliseconds: this._millis });
  }

  public valueOf() {
    return this._millis;
  }

  public toJSON() {
    return this.toString();
  }

  public toString(): string {
    const absMillis = Math.abs(this._millis);
    const negative = this._millis < 0;

    const d = Math.floor(absMillis / TimeSpan.MILLIS_PER_DAY);
    const h = Math.floor((absMillis % TimeSpan.MILLIS_PER_DAY) / TimeSpan.MILLIS_PER_HOUR);
    const m = Math.floor((absMillis % TimeSpan.MILLIS_PER_HOUR) / TimeSpan.MILLIS_PER_MINUTE);
    const s = Math.floor((absMillis % TimeSpan.MILLIS_PER_MINUTE) / TimeSpan.MILLIS_PER_SECOND);
    const ms = Math.floor(absMillis % TimeSpan.MILLIS_PER_SECOND);

    let text = '';
    
    // Include days if present
    if (d > 0) {
      text = `${d}.${to2Digits(h)}:${to2Digits(m)}:${to2Digits(s)}`;
    } else {
      text = `${to2Digits(h)}:${to2Digits(m)}:${to2Digits(s)}`;
    }

    // Include milliseconds if present
    if (ms > 0) {
      text += `.${String(ms).padStart(3, '0')}`;
    }

    if (negative) {
      text = '-' + text;
    }

    return text;
  }

  public static fromDays(value: number): TimeSpan {
    return TimeSpan.interval(value, TimeSpan.MILLIS_PER_DAY);
  }

  public static fromHours(value: number): TimeSpan {
    return TimeSpan.interval(value, TimeSpan.MILLIS_PER_HOUR);
  }

  public static fromMilliseconds(value: number): TimeSpan {
    return TimeSpan.interval(value, 1);
  }

  public static fromMinutes(value: number): TimeSpan {
    return TimeSpan.interval(value, TimeSpan.MILLIS_PER_MINUTE);
  }

  public static fromSeconds(value: number): TimeSpan {
    return TimeSpan.interval(value, TimeSpan.MILLIS_PER_SECOND);
  }

  /**
   * Creates a TimeSpan from a JavaScript Date object
   * Represents the time elapsed from the given date until now
   * @param date - The date to calculate elapsed time from
   * @returns A TimeSpan representing the elapsed time
   */
  public static fromDate(date: Date): TimeSpan {
    const elapsed = Date.now() - date.getTime();
    return new TimeSpan(elapsed);
  }

  /**
   * Creates a TimeSpan from a Luxon DateTime object
   * Represents the time elapsed from the given DateTime until now
   * @param dateTime - The DateTime to calculate elapsed time from
   * @returns A TimeSpan representing the elapsed time
   */
  public static fromDateTime(dateTime: DateTime): TimeSpan {
    const elapsed = DateTime.now().toMillis() - dateTime.toMillis();
    return new TimeSpan(elapsed);
  }

  /**
   * Creates a TimeSpan representing the difference between two dates
   * @param date1 - The first date
   * @param date2 - The second date
   * @returns A TimeSpan representing date1 - date2
   */
  public static between(date1: Date, date2: Date): TimeSpan;
  public static between(date1: DateTime, date2: DateTime): TimeSpan;
  public static between(date1: Date | DateTime, date2: Date | DateTime): TimeSpan {
    let millis1: number;
    let millis2: number;

    if (date1 instanceof Date) {
      millis1 = date1.getTime();
    } else {
      millis1 = date1.toMillis();
    }

    if (date2 instanceof Date) {
      millis2 = date2.getTime();
    } else {
      millis2 = date2.toMillis();
    }

    return new TimeSpan(millis1 - millis2);
  }

  public static fromTime(
    hours: number,
    minutes: number,
    seconds: number,
  ): TimeSpan;
  public static fromTime(
    days: number,
    hours: number,
    minutes: number,
    seconds: number,
    milliseconds: number,
  ): TimeSpan;
  public static fromTime(
    daysOrHours: number,
    hoursOrMinutes: number,
    minutesOrSeconds: number,
    seconds?: number,
    milliseconds?: number,
  ): TimeSpan {
    if (milliseconds != undefined) {
      return this.fromTimeStartingFromDays(
        daysOrHours,
        hoursOrMinutes,
        minutesOrSeconds,
        seconds,
        milliseconds,
      );
    } else {
      return this.fromTimeStartingFromHours(
        daysOrHours,
        hoursOrMinutes,
        minutesOrSeconds,
        0,
      );
    }
  }

  private static fromTimeStartingFromHours(
    hours: number,
    minutes: number,
    seconds: number,
    milliseconds: number,
  ): TimeSpan {
    hours = _is_number(_non_NaN())(hours, 'hours');
    minutes = _is_number(_non_NaN())(minutes, 'minutes');
    seconds = _is_number(_non_NaN())(seconds, 'seconds');
    milliseconds = _is_number(_non_NaN())(milliseconds, 'milliseconds');
    
    const millis =
      TimeSpan.timeToMilliseconds(hours, minutes, seconds) + milliseconds;
    return new TimeSpan(millis);
  }

  private static fromTimeStartingFromDays(
    days: number,
    hours: number,
    minutes: number,
    seconds: number,
    milliseconds: number,
  ): TimeSpan {
    days = _is_number(_non_NaN())(days, 'days');
    hours = _is_number(_non_NaN())(hours, 'hours');
    minutes = _is_number(_non_NaN())(minutes, 'minutes');
    seconds = _is_number(_non_NaN())(seconds, 'seconds');
    milliseconds = _is_number(_non_NaN())(milliseconds, 'milliseconds');
    
    const totalMilliSeconds =
      days * TimeSpan.MILLIS_PER_DAY +
      hours * TimeSpan.MILLIS_PER_HOUR +
      minutes * TimeSpan.MILLIS_PER_MINUTE +
      seconds * TimeSpan.MILLIS_PER_SECOND +
      milliseconds;

    if (
      totalMilliSeconds > TimeSpan.MAX_VALUE.totalMilliseconds ||
      totalMilliSeconds < TimeSpan.MIN_VALUE.totalMilliseconds
    ) {
      throw new Error('TimeSpanTooLong');
    }
    return new TimeSpan(totalMilliSeconds);
  }

  public static parse(span: TimeSpanLike | Date): TimeSpan | null {
    if (span instanceof TimeSpan) {
      return span;
    }

    if (span instanceof Date) {
      // Calculate time elapsed since the date
      span = Date.now() - span.getTime();
    }

    if (typeof span === 'number') {
      return new TimeSpan(span);
    }

    if (!span) {
      return null;
    }

    if (typeof span === 'object') {
      const { days, hours, minutes, seconds, milliseconds } = span;

      return TimeSpan.fromTime(
        days || 0,
        hours || 0,
        minutes || 0,
        seconds || 0,
        milliseconds || 0,
      );
    }

    // Parse string format: "[d.]hh:mm[:ss[.fff]]"
    // Examples: "12:30", "12:30:45", "1.12:30", "1.12:30:45", "12:30:45.123"
    const tokens = span.split(':');
    
    if (tokens.length < 2) {
      throw new Error('Invalid TimeSpan format. Expected format: "[d.]hh:mm[:ss[.fff]]"');
    }

    let seconds = 0;
    let milliseconds = 0;
    
    // Parse seconds and milliseconds if present
    if (tokens.length >= 3) {
      const secondsParts = tokens[2].split('.');
      seconds = +secondsParts[0];
      
      if (secondsParts.length === 2) {
        // Pad or truncate to 3 digits
        const msString = secondsParts[1].padEnd(3, '0').slice(0, 3);
        milliseconds = +msString;
      }
    }

    const daysParts = tokens[0].split('.');
    if (daysParts.length === 2) {
      // Format: "d.hh:mm[:ss[.fff]]"
      return TimeSpan.fromTimeStartingFromDays(
        +daysParts[0],
        +daysParts[1],
        +tokens[1],
        seconds,
        milliseconds,
      );
    }

    // Format: "hh:mm[:ss[.fff]]"
    return TimeSpan.fromTimeStartingFromHours(
      +tokens[0],
      +tokens[1],
      seconds,
      milliseconds,
    );
  }

  private static interval(value: number, scale: number): TimeSpan {
    value = _is_number(_non_NaN())(value, 'value');

    const tmp = value * scale;
    const millis = TimeSpan.round(tmp + (value >= 0 ? 0.5 : -0.5));
    if (
      millis > TimeSpan.MAX_VALUE.totalMilliseconds ||
      millis < TimeSpan.MIN_VALUE.totalMilliseconds
    ) {
      throw new Error('TimeSpanTooLong');
    }

    return new TimeSpan(millis);
  }

  private static round(n: number): number {
    if (n < 0) {
      return Math.ceil(n);
    } else if (n > 0) {
      return Math.floor(n);
    }

    return 0;
  }

  private static timeToMilliseconds(
    hour: number,
    minute: number,
    second: number,
  ): number {
    const totalSeconds = hour * 3600 + minute * 60 + second;
    if (
      totalSeconds > TimeSpan.MAX_VALUE.totalSeconds ||
      totalSeconds < TimeSpan.MIN_VALUE.totalSeconds
    ) {
      throw new Error('TimeSpanTooLong');
    }

    return totalSeconds * TimeSpan.MILLIS_PER_SECOND;
  }
}

function to2Digits(n : number) {
  return String(n).padStart(2, '0');
}