import { DateTime } from 'luxon';

/** The instant of a datetime as a driver returns it or as text read with a cast; text without an offset is UTC. */
export function readInstant(v: DateTime | Date | string | null | undefined): Date | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (v instanceof Date) {
    return new Date(v.getTime());
  }
  if (typeof v === 'string') {
    const sql = DateTime.fromSQL(v, { zone: 'utc' });
    return (sql.isValid ? sql : DateTime.fromISO(v, { zone: 'utc' })).toJSDate();
  }
  return v.toJSDate();
}
