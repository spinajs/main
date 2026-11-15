import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary, UniqueViolation } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { selectFrom } from '../records.js';
import { POLICY_VERSION_TABLE } from './table.js';

const POLICY_HASH = /^[0-9a-f]{64}$/;

/** An `authz_policy_version` row: the canonical policy IR the app ran with under that hash. */
@Connection(AUTHZ_CONNECTION)
@Model(POLICY_VERSION_TABLE)
export class PolicyVersionRecord extends ModelBase<PolicyVersionRecord> {
  @Primary({ generated: 'assigned' })
  public policy_hash!: string;

  public ir!: string;

  @DateTimeColumn()
  public first_seen_at!: DateTime;
}

export interface PolicyVersion {
  readonly policyHash: string;
  /** The IR as stored: the canonical JSON its hash was computed from. */
  readonly ir: string;
  readonly firstSeenAt: Date;
}

function checkHash(policyHash: string, where: string): void {
  if (typeof policyHash !== 'string' || !POLICY_HASH.test(policyHash)) throw new AuthzConfigError(`${where}: policyHash must be 64 lowercase hex characters (sha256)`);
}

/**
 * Stores the policy IR under its hash unless the hash is known already; true when it was new. The IR text is kept
 * verbatim, so a replay can recompute the hash from it. Boot calls it with the running policy (L1/Z wiring).
 */
export async function recordPolicyVersion(policyHash: string, irJson: string, now: Date = new Date()): Promise<boolean> {
  const where = 'recordPolicyVersion';
  checkHash(policyHash, where);
  if (typeof irJson !== 'string' || irJson === '') throw new AuthzConfigError(`${where}: the IR must be non-empty JSON text`);
  if ((await readPolicyVersion(policyHash)) !== undefined) return false;
  try {
    await PolicyVersionRecord.insert({ policy_hash: policyHash, ir: irJson, first_seen_at: DateTime.fromJSDate(now) });
    return true;
  } catch (err) {
    // Another process booted with the same policy meanwhile: the row is there, which is what was asked.
    if (err instanceof UniqueViolation) return false;
    throw err;
  }
}

export async function readPolicyVersion(policyHash: string): Promise<PolicyVersion | undefined> {
  checkHash(policyHash, 'readPolicyVersion');
  const row = (await selectFrom(PolicyVersionRecord).where('policy_hash', policyHash).first()) as PolicyVersionRecord | undefined;
  return row ? { policyHash: row.policy_hash, ir: row.ir, firstSeenAt: row.first_seen_at.toJSDate() } : undefined;
}
