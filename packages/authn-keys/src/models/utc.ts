import { DateTime } from 'luxon';

// The ORM writes a DateTime as wall-clock text without an offset and reads it back in the local zone. Writing UTC
// wall-clock time and reading it as UTC keeps instants right across processes in other zones and across DST changes.

export const toUtcColumn = (d: Date): DateTime => DateTime.fromJSDate(d, { zone: 'utc' });

export function fromUtcColumn(v: DateTime | Date | string | null | undefined): Date | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (v instanceof Date) {
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds()));
  }
  if (typeof v === 'string') {
    const sql = DateTime.fromSQL(v, { zone: 'utc' });
    return (sql.isValid ? sql : DateTime.fromISO(v, { zone: 'utc' })).toJSDate();
  }
  return v.setZone('utc', { keepLocalTime: true }).toJSDate();
}
