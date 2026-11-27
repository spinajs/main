import { randomUUID } from 'node:crypto';
import { RowLease } from '@spinajs/durable';
import { ConcurrencyConflict } from '@spinajs/exceptions';

import { TENANTS_TABLE } from '../connection.js';
import { tenancyDriver } from './record.js';

export const LIFECYCLE_LEASE_COLUMNS = { owner: 'lifecycle_owner', until: 'lifecycle_until', epoch: 'lifecycle_epoch' };

/** Measured on the clock `claimLifecycle` is given as `now`. */
export const LIFECYCLE_LEASE_MS = 15 * 60_000;

export interface LifecycleLease {
  /** The conditions of a write that must commit only while this lease holds. */
  readonly fence: Readonly<Record<string, unknown>>;
  renew(): Promise<void>;
  release(): Promise<void>;
}

/** Takes tenant `id` for one lifecycle operation; another live operation holding it refuses the call. */
export async function claimLifecycle(id: string, now: () => number): Promise<LifecycleLease> {
  const lease = new RowLease(await tenancyDriver(), LIFECYCLE_LEASE_COLUMNS);
  const target = { table: TENANTS_TABLE, key: { id } };
  const owner = randomUUID();
  const claimed = await lease.claim(target, owner, LIFECYCLE_LEASE_MS, now());
  if (claimed === null) {
    throw new ConcurrencyConflict(`tenancy-orm: another lifecycle operation holds tenant "${id}"; retry when it ended (one whose process died frees the tenant after ${LIFECYCLE_LEASE_MS / 60_000} minutes)`);
  }
  return {
    fence: lease.fenced(target, owner, claimed.epoch),
    renew: async () => {
      if (!(await lease.renew(target, owner, claimed.epoch, LIFECYCLE_LEASE_MS, now()))) {
        throw new ConcurrencyConflict(`tenancy-orm: the lifecycle operation of tenant "${id}" lost its hold on the tenant`);
      }
    },
    release: async () => {
      await lease.release(target, owner, claimed.epoch);
    },
  };
}
