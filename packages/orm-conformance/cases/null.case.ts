import { CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const names = (users: CfUser[]) => users.map((u) => u.Name);

export const NULL_CASES = [
  defineCase({ name: 'where-null', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereNull('Email')) }),
  defineCase({ name: 'where-not-null', seed: BASE, order: 'unordered', run: async () => names(await CfUser.query().whereNotNull('Age')) }),
  defineCase({ name: 'where-eq-null', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Email', null)) }),
];
