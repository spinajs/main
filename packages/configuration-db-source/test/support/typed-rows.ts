import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { OrmDriver } from '@spinajs/orm';

import { DbConfig } from '../../src/index.js';

type StoredRow = Record<string, unknown>;

interface TypedOption {
  readonly name: string;
  readonly type: 'json' | 'manyOf' | 'number' | 'boolean';
  /** The canonical text of the value already in the row. */
  readonly stored: string;
  readonly value: unknown;
  readonly newDefault: unknown;
  readonly newDefaultStored: string;
}

const OPTIONS: readonly TypedOption[] = [
  { name: 'json', type: 'json', stored: '{"a":1}', value: { a: 1 }, newDefault: { a: 2, b: [1, 2] }, newDefaultStored: '{"a":2,"b":[1,2]}' },
  { name: 'many-of', type: 'manyOf', stored: '["a"]', value: ['a'], newDefault: ['b', 'c'], newDefaultStored: '["b","c"]' },
  { name: 'number', type: 'number', stored: '1', value: 1, newDefault: 5, newDefaultStored: '5' },
  { name: 'boolean', type: 'boolean', stored: 'false', value: false, newDefault: true, newDefaultStored: 'true' },
];

async function stored(driver: OrmDriver, slug: string): Promise<StoredRow | undefined> {
  return (await driver.select().from('configuration').where('Slug', slug).first()) as StoredRow | undefined;
}

/**
 * Exposed options whose row predates a release: the sync rewrites their metadata and Default through an instance
 * update, the configuration panel writes Value the same way. Both go through the column converters of `DbConfig`.
 */
export function typedRowCases(prefix: string, driverOf: () => Promise<OrmDriver>, settle: () => Promise<void>): void {
  // Exposed options stay registered for the whole run; a prefix per suite keeps one suite's rows out of the other's boot.
  const slug = (name: string) => `${prefix}.${name}`;

  it('syncs an exposed json, manyOf, number and boolean option and keeps their types', async () => {
    const driver = await driverOf();
    for (const o of OPTIONS) {
      await driver.insert().into('configuration').values({ Slug: slug(o.name), Type: o.type, Group: 'stale', Label: 'stale', Value: o.stored, Default: o.stored, Exposed: true });
    }

    for (const o of OPTIONS) {
      DI.register({
        path: slug(o.name),
        options: { expose: true, defaultValue: o.newDefault, exposeOptions: { type: o.type, group: 'db-config', label: 'Fresh label' } },
      }).asValue('__configuration_property__');
    }
    await settle();

    const config = DI.get(Configuration)!;
    for (const o of OPTIONS) {
      const row = await stored(driver, slug(o.name));
      expect(row?.Label, `${o.name} metadata`).to.equal('Fresh label');
      expect(row?.Default, `${o.name} stored Default`).to.equal(o.newDefaultStored);
      expect(row?.Value, `${o.name} stored Value`).to.equal(o.stored);

      const model = await DbConfig.where('Slug', slug(o.name)).firstOrFail();
      expect(model.Value, `${o.name} Value`).to.deep.equal(o.value);
      expect(model.Default, `${o.name} Default`).to.deep.equal(o.newDefault);
      expect(config.get(slug(o.name)), `${o.name} in the configuration`).to.deep.equal(o.value);
    }
  });

  it('stores a manyOf value written by an instance update as JSON and leaves the other columns alone', async () => {
    const driver = await driverOf();
    await driver.insert().into('configuration').values({ Slug: slug('panel'), Type: 'manyOf', Group: 'test', Value: '["a"]', Default: '["a"]', Meta: '{"options":["a","b","c"]}', Exposed: true });
    const before = await stored(driver, slug('panel'));

    const row = await DbConfig.where('Slug', slug('panel')).firstOrFail();
    row.Value = ['a', 'b'];
    await row.update();

    const after = await stored(driver, slug('panel'));
    expect(after?.Value).to.equal('["a","b"]');
    expect({ ...after, Value: undefined }).to.deep.equal({ ...before, Value: undefined });
    expect((await DbConfig.where('Slug', slug('panel')).firstOrFail()).Value).to.deep.equal(['a', 'b']);
  });
}
