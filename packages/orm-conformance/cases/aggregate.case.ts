import { CfPost, CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

type Row = Record<string, unknown>;

export const AGGREGATE_CASES = [
  // asRaw(): an aggregate row is not a model, and hydrating it would compare hydrator output, not the dialects.
  defineCase({
    name: 'count',
    seed: BASE,
    order: 'ordered',
    run: async () => ({ all: await CfPost.query().count('Id', 'n').asRaw<Row[]>(), viewed: await CfPost.query().where('Views', '>', 0).count('Id', 'n').asRaw<Row[]>() }),
  }),
  defineCase({
    name: 'sum-min-max',
    seed: BASE,
    order: 'ordered',
    run: async () => CfPost.query().sum('Views', 'total').min('Views', 'lowest').max('Views', 'highest').asRaw<Row[]>(),
  }),
  // 129 / 4 = 32.25: an integer AVG ( SQL Server's ) truncates it.
  defineCase({ name: 'avg-fraction', seed: BASE, order: 'ordered', run: async () => CfUser.query().avg('Age', 'average').asRaw<Row[]>() }),
  defineCase({ name: 'group-by', seed: BASE, order: 'unordered', run: async () => CfPost.query().select('UserId').count('Id', 'posts').groupBy('UserId').asRaw<Row[]>() }),
  defineCase({ name: 'distinct', seed: BASE, order: 'unordered', run: async () => CfPost.query().select('UserId').distinct().asRaw<Row[]>() }),
];
