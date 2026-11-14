import { CfPost, CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

export const JOIN_CASES = [
  defineCase({ name: 'inner-join', seed: BASE, order: 'unordered', run: async () => (await CfUser.query().innerJoin('Posts')).map((u) => u.Name) }),
  defineCase({ name: 'where-exists', seed: BASE, order: 'unordered', run: async () => (await CfUser.query().whereExist('Posts')).map((u) => u.Name) }),
  defineCase({ name: 'where-not-exists', seed: BASE, order: 'unordered', run: async () => (await CfUser.query().whereNotExists('Posts')).map((u) => u.Name) }),
  defineCase({
    name: 'where-exists-filtered',
    seed: BASE,
    order: 'unordered',
    run: async () =>
      (
        await CfPost.query().whereExist('Author', function () {
          this.where('Active', true);
        })
      ).map((p) => p.Title),
  }),
];
