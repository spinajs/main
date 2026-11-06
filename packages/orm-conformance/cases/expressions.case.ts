import { IdentifierQuoter, RawQuery, SqlExpressions, type OrmDriver } from '@spinajs/orm';

import { CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const expressions = (driver: OrmDriver) => driver.Container.resolve(SqlExpressions);
const names = (users: CfUser[]) => users.map((u) => u.Name);

export const EXPRESSION_CASES = [
  defineCase({
    name: 'epoch-millis',
    seed: BASE,
    order: 'ordered',
    run: async ({ driver }) => {
      const rows = (await driver.select().select(RawQuery.create(`${expressions(driver).epochMillis()} AS ms`)).from('cf_users').where('Name', 'Ann')) as Array<{ ms: number | string }>;
      return { near: Math.abs(Number(rows[0].ms) - Date.now()) < 5000 };
    },
  }),
  defineCase({
    name: 'concat',
    seed: BASE,
    order: 'unordered',
    run: async ({ driver }) => {
      const label = expressions(driver).concat(`'<'`, driver.Container.resolve(IdentifierQuoter).quote('Name'), `'>'`);
      const rows = (await driver.select().select(RawQuery.create(`${label} AS label`)).from('cf_users').where('Age', 31)) as Array<{ label: string }>;
      return rows.map((r) => r.label);
    },
  }),
  defineCase({ name: 'row-lock-update', seed: BASE, order: 'unordered', run: async ({ driver }) => driver.transaction(async () => names(await CfUser.where('Age', 31).forUpdate())) }),
  defineCase({ name: 'row-lock-share', seed: BASE, order: 'unordered', run: async ({ driver }) => driver.transaction(async () => names(await CfUser.where('Age', 31).forShare())) }),
];
