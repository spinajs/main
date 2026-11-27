import { expect } from 'chai';
import type { OrmDriver } from '@spinajs/orm';

import { SHARED_SCOPE, configuration_db_source_2026_11_26_00_00_00 } from '../../src/index.js';

const plain = (Slug: string, Value: string) => ({ Slug, Value, Type: 'string', Exposed: true });

async function refused(write: () => PromiseLike<unknown>): Promise<boolean> {
  try {
    await write();
    return false;
  } catch {
    return true;
  }
}

/** The Scope migration on a driver whose `configuration` table the migrations already created. */
export function scopeMigrationCases(driverOf: () => Promise<OrmDriver>): void {
  it('the Scope migration makes every existing row shared and keeps a slug unique per scope', async () => {
    const driver = await driverOf();
    const migration = new configuration_db_source_2026_11_26_00_00_00();
    await migration.down(driver);
    await driver.insert().into('configuration').values(plain('scope.before', 'a'));

    await migration.up(driver);

    const before = (await driver.select().from('configuration').where('Slug', 'scope.before').first()) as { Scope?: unknown } | undefined;
    expect(before?.Scope).to.equal(SHARED_SCOPE);
    await driver.insert().into('configuration').values({ ...plain('scope.before', 'b'), Scope: 'tenant:acme' });
    expect(await refused(() => driver.insert().into('configuration').values({ ...plain('scope.before', 'c'), Scope: 'tenant:acme' })), 'a second row of one scope').to.equal(true);
    expect(await refused(() => driver.insert().into('configuration').values(plain('scope.before', 'd'))), 'a second shared row').to.equal(true);
    expect(await driver.select().from('configuration').where('Slug', 'scope.before')).to.have.length(2);
  });
}
