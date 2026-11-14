import { CfPost, CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const titles = (posts: CfPost[]) => posts.map((p) => p.Title);

export const ORDER_CASES = [
  // Cid has no age: PostgreSQL sorts NULL last in ascending order, sqlite, MySQL and SQL Server first.
  defineCase({ name: 'order-nulls-asc', seed: BASE, order: 'ordered', run: async () => (await CfUser.query().orderBy('Age').orderBy('Id')).map((u) => u.Name) }),
  defineCase({ name: 'order-multi', seed: BASE, order: 'ordered', run: async () => titles(await CfPost.query().orderByDescending('Views').orderBy('Id')) }),
  defineCase({ name: 'order-offset', seed: BASE, order: 'ordered', run: async () => titles(await CfPost.query().orderBy('Id').skip(2).take(2)) }),
];
