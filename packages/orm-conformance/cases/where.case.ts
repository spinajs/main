import { CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const names = (users: CfUser[]) => users.map((u) => u.Name);

export const WHERE_CASES = [
  defineCase({ name: 'where-eq', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Age', 31)) }),
  defineCase({ name: 'where-gt', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Age', '>', 30)) }),
  defineCase({ name: 'where-between', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereBetween('Age', [25, 31])) }),
  defineCase({ name: 'where-or', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Age', 25).orWhere('Age', 42)) }),
  defineCase({
    name: 'where-nested',
    seed: BASE,
    order: 'unordered',
    run: async () =>
      names(
        await CfUser.where(function () {
          this.where('Age', '>', 30);
          this.orWhere('Active', false);
        }).where('Email', 'like', '%x.io'),
      ),
  }),
  defineCase({ name: 'where-in', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereIn('Id', [1, 3, 5])) }),
  defineCase({ name: 'where-in-empty', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereIn('Id', [])) }),
  defineCase({ name: 'where-not-in', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereNotIn('Id', [1, 2])) }),
  defineCase({ name: 'where-not-in-empty', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereNotIn('Id', [])) }),
];
