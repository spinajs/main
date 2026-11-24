import { extractModelDescriptor, pkColumns, pkGeneration } from '@spinajs/orm';
import type { DbServerResponse, InsertQueryBuilder } from '@spinajs/orm';

type InsertedKey = Record<string, unknown>;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * Turns on the session tracker for `auto_increment_increment`, then sets the step to itself so that this statement's OK
 * packet already reports it. Without session tracking (an old server, or a client without the SESSION_TRACK flag) the
 * packet reports nothing and the step of the connection stays unknown.
 */
export const TRACK_AUTO_INCREMENT_STEP =
  "SET SESSION session_track_system_variables = IF(@@SESSION.session_track_system_variables = '*', '*', CONCAT_WS(',', NULLIF(@@SESSION.session_track_system_variables, ''), 'auto_increment_increment')), auto_increment_increment = @@SESSION.auto_increment_increment";

function stepOfPacket(packet: unknown): number | null | undefined {
  if (!isObject(packet) || !('stateChanges' in packet) || !isObject(packet.stateChanges)) return undefined;
  const changes = packet.stateChanges;
  if (!('systemVariables' in changes) || !isObject(changes.systemVariables) || !('auto_increment_increment' in changes.systemVariables)) return undefined;
  const step = Number(changes.systemVariables.auto_increment_increment);
  return Number.isSafeInteger(step) && step > 0 ? step : null;
}

/**
 * The `auto_increment_increment` a statement's OK packets report through the session state tracker: undefined when
 * they report none, null when the reported value is not a usable step.
 */
export function reportedAutoIncrementStep(results: unknown): number | null | undefined {
  const packets: unknown[] = Array.isArray(results) ? results : [results];
  return packets.map(stepOfPacket).reduce((step, reported) => (reported === undefined ? step : reported), undefined);
}

function autoIncrementStepOf(response: unknown): number | undefined {
  if (!isObject(response) || !('AutoIncrementStep' in response)) return undefined;
  const step = response.AutoIncrementStep;
  return typeof step === 'number' && Number.isSafeInteger(step) && step > 0 ? step : undefined;
}

function identityColumn(insert: InsertQueryBuilder): string | undefined {
  const descriptor = insert.Model === undefined ? null : extractModelDescriptor(insert.Model);
  const pk = descriptor ? pkColumns(descriptor) : [];
  if (!descriptor || pk.length !== 1 || pkGeneration(descriptor, pk[0]) !== 'auto') return undefined;
  return descriptor.Columns.find((c) => c.Name === pk[0])?.AutoIncrement === true ? pk[0] : undefined;
}

// Measured on MySQL 8.4: INSERT and INSERT IGNORE count 1 for the inserted row and 0 for a skipped one; REPLACE 1 plus
// the rows it deleted; ON DUPLICATE KEY UPDATE 1 inserted, 2 updated (the insert id is then the updated row's key).
function wroteOneRow(rowsAffected: number, insert: InsertQueryBuilder): boolean {
  if (insert.Replace) return rowsAffected >= 1;
  if (insert.Update) return !insert.Ignore && (rowsAffected === 1 || rowsAffected === 2);
  return rowsAffected === 1;
}

// InnoDB reserves one block for a statement whose row count it knows up front (a "simple insert", every plain
// INSERT ... VALUES) and reports its first value, under every innodb_autoinc_lock_mode. Rows that carry a key, a skipped
// or replaced row, or a second statement break the block.
function isSimpleBatch(rowsAffected: number, insert: InsertQueryBuilder, pk: string): boolean {
  if (insert.Ignore || insert.Replace || insert.Update || rowsAffected !== insert.Values.length) return false;
  return insert.getColumnValues(pk).every((v) => v === null || v === undefined) && insert.splitByDriverLimits().length === 1;
}

/**
 * MySQL's keys of the rows an insert wrote: `insertId` for one row, and for several rows of one plain statement the
 * block from the first id, advancing by the connection's `auto_increment_increment`.
 */
export function mysqlInsertedKeys(mapped: DbServerResponse, response: unknown, insert: InsertQueryBuilder): InsertedKey[] | undefined {
  const pk = identityColumn(insert);
  const first = mapped.LastInsertId;
  if (pk === undefined || !Number.isSafeInteger(first) || first <= 0) return undefined;

  const rows = insert.Values.length;
  if (rows === 1) return wroteOneRow(mapped.RowsAffected, insert) ? [{ [pk]: first }] : undefined;

  const step = autoIncrementStepOf(response);
  if (step === undefined || !isSimpleBatch(mapped.RowsAffected, insert, pk) || !Number.isSafeInteger(first + (rows - 1) * step)) return undefined;
  return Array.from({ length: rows }, (_, k) => ({ [pk]: first + k * step }));
}
