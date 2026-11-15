import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

import { ChangeLogRecord } from './record.js';
import { CHANGELOG_RETENTION_DAYS_DEFAULT } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `authz.changelog.retentionDays`, the schema default when the configuration has none. */
export function changeLogRetentionDays(): number {
  const days = (DI.get(Configuration) as Configuration | undefined)?.get<unknown>(['authz', 'changelog', 'retentionDays']);
  return typeof days === 'number' ? days : CHANGELOG_RETENTION_DAYS_DEFAULT;
}

/** Deletes the changes recorded more than `days` days before `now`; returns how many. */
export async function pruneChangeLog(days: number = changeLogRetentionDays(), now: Date = new Date()): Promise<number> {
  if (!Number.isInteger(days) || days < 1) throw new AuthzConfigError(`pruneChangeLog: retentionDays must be a positive integer, got ${String(days)}`);
  const cutoff = DateTime.fromJSDate(new Date(now.getTime() - days * DAY_MS));
  const { RowsAffected } = await ChangeLogRecord.destroy().where('at', '<', cutoff);
  return RowsAffected;
}
