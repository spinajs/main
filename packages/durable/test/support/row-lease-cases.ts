import { expect } from 'chai';
import type { OrmDriver } from '@spinajs/orm';
import { RowLease, RowLeaseTarget } from '../../src/index.js';

export const LEASE_TABLE = 'durable_lease_test';

export interface LeaseRow {
  Id: string;
  Status: string | null;
  ClaimedBy: string | null;
  ClaimedUntil: number | string | null;
  ClaimEpoch: number | string;
}

const T0 = 1_000_000;
const TTL = 1000;

/** Shared by the sqlite suite and the Postgres/MySQL integration suite; `boot` returns a driver whose `LEASE_TABLE` is empty. */
export function describeRowLease(boot: () => Promise<OrmDriver>): void {
  let driver: OrmDriver;
  let lease: RowLease;
  const target = (id = 'r1'): RowLeaseTarget => ({ table: LEASE_TABLE, key: { Id: id } });
  const row = async (id = 'r1') => {
    const rows = (await driver.select().from(LEASE_TABLE).where({ Id: id })) as LeaseRow[];
    const r = rows[0];
    return { ...r, ClaimedUntil: r.ClaimedUntil === null ? null : Number(r.ClaimedUntil), ClaimEpoch: Number(r.ClaimEpoch) };
  };
  const fencedUpdate = async (where: Record<string, unknown>) => {
    const r = (await driver.update().in(LEASE_TABLE).update({ Status: 'written' }).where(where)) as { RowsAffected?: number };
    return r.RowsAffected ?? 0;
  };

  beforeEach(async () => {
    driver = await boot();
    lease = new RowLease(driver);
    await driver.insert().into(LEASE_TABLE).values({ Id: 'r1', Status: 'due' });
  });

  it('claims a free row, sets owner and expiry and increments the epoch', async () => {
    expect(await lease.claim(target(), 'a', TTL, T0)).to.deep.eq({ epoch: 1 });
    expect(await row()).to.include({ ClaimedBy: 'a', ClaimedUntil: T0 + TTL, ClaimEpoch: 1 });
  });

  it('refuses a second owner while the lease is valid, including at the expiry instant', async () => {
    await lease.claim(target(), 'a', TTL, T0);
    expect(await lease.claim(target(), 'b', TTL, T0 + 500)).to.eq(null);
    expect(await lease.claim(target(), 'b', TTL, T0 + TTL)).to.eq(null);
    expect(await lease.claim(target(), 'a', TTL, T0 + 500)).to.eq(null);
    expect(await row()).to.include({ ClaimedBy: 'a', ClaimEpoch: 1 });
  });

  it('lets a second owner win after the expiry, with the next epoch', async () => {
    await lease.claim(target(), 'a', TTL, T0);
    expect(await lease.claim(target(), 'b', TTL, T0 + TTL + 1)).to.deep.eq({ epoch: 2 });
    expect(await row()).to.include({ ClaimedBy: 'b', ClaimedUntil: T0 + 2 * TTL + 1, ClaimEpoch: 2 });
  });

  it('claims only when the extra conditions match', async () => {
    expect(await lease.claim(target(), 'a', TTL, T0, { Status: 'done' })).to.eq(null);
    expect(await lease.claim(target(), 'a', TTL, T0, { Status: 'due' })).to.deep.eq({ epoch: 1 });
    await lease.release(target(), 'a', 1);
    await driver.update().in(LEASE_TABLE).update({ Status: null }).where({ Id: 'r1' });
    expect(await lease.claim(target(), 'a', TTL, T0, { Status: null })).to.deep.eq({ epoch: 2 });
  });

  it('returns null for a missing row', async () => {
    expect(await lease.claim(target('nope'), 'a', TTL, T0)).to.eq(null);
  });

  it('renews only with the current owner and epoch', async () => {
    await lease.claim(target(), 'a', TTL, T0);
    await lease.claim(target(), 'b', TTL, T0 + TTL + 1);
    expect(await lease.renew(target(), 'a', 1, TTL, T0 + TTL + 2)).to.eq(false);
    expect(await lease.renew(target(), 'b', 1, TTL, T0 + TTL + 2)).to.eq(false);
    expect(await lease.renew(target(), 'b', 2, TTL, T0 + TTL + 2)).to.eq(true);
    expect(await row()).to.include({ ClaimedBy: 'b', ClaimedUntil: T0 + 2 * TTL + 2, ClaimEpoch: 2 });
  });

  it('fences writes: a stale epoch affects 0 rows, the current one affects 1', async () => {
    await lease.claim(target(), 'a', TTL, T0);
    const stale = lease.fenced(target(), 'a', 1);
    await lease.claim(target(), 'b', TTL, T0 + TTL + 1);
    expect(stale).to.deep.eq({ Id: 'r1', ClaimedBy: 'a', ClaimEpoch: 1 });
    expect(await fencedUpdate(stale)).to.eq(0);
    expect(await fencedUpdate(lease.fenced(target(), 'b', 2))).to.eq(1);
    expect((await row()).Status).to.eq('written');
  });

  it('never hands one epoch to two overlapping claims of the same owner', async () => {
    const claims = await Promise.all([lease.claim(target(), 'a', TTL, 0), lease.claim(target(), 'a', TTL, 2 * TTL)]);
    const won = claims.filter((c): c is { epoch: number } => c !== null);
    expect(won.length).to.be.greaterThan(0);
    expect(new Set(won.map((c) => c.epoch)).size).to.eq(won.length);
    let fencedWrites = 0;
    for (const c of won) fencedWrites += await fencedUpdate(lease.fenced(target(), 'a', c.epoch));
    expect(fencedWrites).to.eq(1);
    expect((await row()).ClaimEpoch).to.eq(Math.max(...won.map((c) => c.epoch)));
  });

  it('lets exactly one of two concurrent owners claim a free row, raising the epoch by one', async () => {
    const claims = await Promise.all([lease.claim(target(), 'a', TTL, T0), lease.claim(target(), 'b', TTL, T0)]);
    const won = claims.filter((c) => c !== null);
    expect(won).to.deep.eq([{ epoch: 1 }]);
    expect(await row()).to.include({ ClaimedBy: claims[0] ? 'a' : 'b', ClaimEpoch: 1 });
  });

  it('releases with the current owner and epoch, clearing the owner and keeping the epoch', async () => {
    await lease.claim(target(), 'a', TTL, T0);
    expect(await lease.release(target(), 'a', 2)).to.eq(false);
    expect(await lease.release(target(), 'b', 1)).to.eq(false);
    expect(await lease.release(target(), 'a', 1)).to.eq(true);
    expect(await row()).to.include({ ClaimedBy: null, ClaimedUntil: null, ClaimEpoch: 1 });
    expect(await lease.claim(target(), 'b', TTL, T0 + 1)).to.deep.eq({ epoch: 2 });
  });
}
