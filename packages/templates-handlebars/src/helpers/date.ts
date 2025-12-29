import { DateTime } from 'luxon';

/**
 * Formats a date according to the specified format string
 * Usage: {{formatDate date "dd/MM/yyyy"}}
 * 
 * @param date - Can be Date, DateTime, or ISO string
 * @param format - Luxon format string (e.g., "dd/MM/yyyy HH:mm:ss")
 * @returns Formatted date string
 */
export function formatDate(date: unknown, format: string): string {
  if (date instanceof Date) {
    const dt = DateTime.fromJSDate(date);
    return dt.toFormat(format);
  }

  if (date instanceof DateTime) {
    return date.toFormat(format);
  }

  if (typeof date !== 'string') {
    return '';
  }

  const dateString = date as string;
  const dt = DateTime.fromISO(dateString);
  if (!dt.isValid) {
    return dateString;
  }
  return dt.toFormat(format);
}

/**
 * Get current date/time
 * Usage: {{now "dd/MM/yyyy HH:mm:ss"}}
 */
export function now(format?: string): string {
  const dt = DateTime.now();
  return format ? dt.toFormat(format) : dt.toISO();
}

/**
 * Get date relative to now (e.g., "2 days ago", "in 3 hours")
 * Usage: {{dateRelative date}}
 */
export function dateRelative(date: unknown): string {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return '';
  }

  if (!dt.isValid) return '';
  return dt.toRelative() || '';
}

/**
 * Add time to date
 * Usage: {{dateAdd date 5 "days"}}
 * Units: years, months, weeks, days, hours, minutes, seconds
 */
export function dateAdd(date: unknown, amount: number, unit: string): string {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return '';
  }

  if (!dt.isValid) return '';

  const units: any = {
    year: 'years',
    years: 'years',
    month: 'months',
    months: 'months',
    week: 'weeks',
    weeks: 'weeks',
    day: 'days',
    days: 'days',
    hour: 'hours',
    hours: 'hours',
    minute: 'minutes',
    minutes: 'minutes',
    second: 'seconds',
    seconds: 'seconds',
  };

  const normalizedUnit = units[unit.toLowerCase()] || 'days';
  return dt.plus({ [normalizedUnit]: amount }).toISO();
}

/**
 * Subtract time from date
 * Usage: {{dateSubtract date 5 "days"}}
 */
export function dateSubtract(date: unknown, amount: number, unit: string): string {
  return dateAdd(date, -amount, unit);
}

/**
 * Get difference between two dates
 * Usage: {{dateDiff date1 date2 "days"}}
 * Returns number of units between dates
 */
export function dateDiff(date1: unknown, date2: unknown, unit: string = 'days'): number {
  let dt1: DateTime, dt2: DateTime;

  if (date1 instanceof Date) {
    dt1 = DateTime.fromJSDate(date1);
  } else if (date1 instanceof DateTime) {
    dt1 = date1;
  } else if (typeof date1 === 'string') {
    dt1 = DateTime.fromISO(date1 as string);
  } else {
    return 0;
  }

  if (date2 instanceof Date) {
    dt2 = DateTime.fromJSDate(date2);
  } else if (date2 instanceof DateTime) {
    dt2 = date2;
  } else if (typeof date2 === 'string') {
    dt2 = DateTime.fromISO(date2 as string);
  } else {
    return 0;
  }

  if (!dt1.isValid || !dt2.isValid) return 0;

  const units: any = {
    year: 'years',
    years: 'years',
    month: 'months',
    months: 'months',
    week: 'weeks',
    weeks: 'weeks',
    day: 'days',
    days: 'days',
    hour: 'hours',
    hours: 'hours',
    minute: 'minutes',
    minutes: 'minutes',
    second: 'seconds',
    seconds: 'seconds',
  };

  const normalizedUnit = units[unit.toLowerCase()] || 'days';
  const diff = dt2.diff(dt1, normalizedUnit as any);
  return Math.floor(diff.as(normalizedUnit));
}

/**
 * Check if date is before another date
 * Usage: {{#if (dateBefore date1 date2)}}...{{/if}}
 */
export function dateBefore(date1: unknown, date2: unknown): boolean {
  return dateDiff(date1, date2) > 0;
}

/**
 * Check if date is after another date
 * Usage: {{#if (dateAfter date1 date2)}}...{{/if}}
 */
export function dateAfter(date1: unknown, date2: unknown): boolean {
  return dateDiff(date1, date2) < 0;
}

/**
 * Check if date is between two dates
 * Usage: {{#if (dateBetween date start end)}}...{{/if}}
 */
export function dateBetween(date: unknown, start: unknown, end: unknown): boolean {
  return dateBefore(start, date) && dateBefore(date, end);
}

/**
 * Get start of time period
 * Usage: {{dateStartOf date "month"}}
 * Units: year, month, week, day, hour, minute, second
 */
export function dateStartOf(date: unknown, unit: string): string {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return '';
  }

  if (!dt.isValid) return '';

  const units: any = {
    year: 'year',
    month: 'month',
    week: 'week',
    day: 'day',
    hour: 'hour',
    minute: 'minute',
    second: 'second',
  };

  const normalizedUnit = units[unit.toLowerCase()] || 'day';
  return dt.startOf(normalizedUnit as any).toISO();
}

/**
 * Get end of time period
 * Usage: {{dateEndOf date "month"}}
 */
export function dateEndOf(date: unknown, unit: string): string {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return '';
  }

  if (!dt.isValid) return '';

  const units: any = {
    year: 'year',
    month: 'month',
    week: 'week',
    day: 'day',
    hour: 'hour',
    minute: 'minute',
    second: 'second',
  };

  const normalizedUnit = units[unit.toLowerCase()] || 'day';
  return dt.endOf(normalizedUnit as any).toISO();
}

/**
 * Format date as ISO string
 * Usage: {{dateISO date}}
 */
export function dateISO(date: unknown): string {
  if (date instanceof Date) {
    return DateTime.fromJSDate(date).toISO();
  }
  if (date instanceof DateTime) {
    return date.toISO();
  }
  if (typeof date === 'string') {
    const dt = DateTime.fromISO(date);
    return dt.isValid ? dt.toISO() : date;
  }
  return '';
}

/**
 * Get timestamp (milliseconds since epoch)
 * Usage: {{timestamp date}}
 */
export function timestamp(date?: unknown): number {
  if (!date) return DateTime.now().toMillis();

  if (date instanceof Date) {
    return DateTime.fromJSDate(date).toMillis();
  }
  if (date instanceof DateTime) {
    return date.toMillis();
  }
  if (typeof date === 'string') {
    const dt = DateTime.fromISO(date);
    return dt.isValid ? dt.toMillis() : 0;
  }
  return 0;
}

/**
 * Get Unix timestamp (seconds since epoch)
 * Usage: {{unixTimestamp date}}
 */
export function unixTimestamp(date?: unknown): number {
  return Math.floor(timestamp(date) / 1000);
}

/**
 * Parse date from timestamp
 * Usage: {{fromTimestamp 1640000000000 "dd/MM/yyyy"}}
 */
export function fromTimestamp(ts: number, format?: string): string {
  const dt = DateTime.fromMillis(ts);
  return format ? dt.toFormat(format) : dt.toISO();
}

/**
 * Get year from date
 * Usage: {{year date}}
 */
export function year(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.year : 0;
}

/**
 * Get month from date (1-12)
 * Usage: {{month date}}
 */
export function month(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.month : 0;
}

/**
 * Get day of month from date (1-31)
 * Usage: {{day date}}
 */
export function day(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.day : 0;
}

/**
 * Get hour from date (0-23)
 * Usage: {{hour date}}
 */
export function hour(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.hour : 0;
}

/**
 * Get minute from date (0-59)
 * Usage: {{minute date}}
 */
export function minute(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.minute : 0;
}

/**
 * Get weekday from date (1=Monday, 7=Sunday)
 * Usage: {{weekday date}}
 */
export function weekday(date: unknown): number {
  let dt: DateTime;

  if (date instanceof Date) {
    dt = DateTime.fromJSDate(date);
  } else if (date instanceof DateTime) {
    dt = date;
  } else if (typeof date === 'string') {
    dt = DateTime.fromISO(date);
  } else {
    return 0;
  }

  return dt.isValid ? dt.weekday : 0;
}
