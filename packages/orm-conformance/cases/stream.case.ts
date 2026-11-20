import { CfUser, defineCase } from '../src/index.js';
import { BASE, manyUsers, userNames } from './seeds.js';

const sorted = (values: string[]) => [...values].sort();

const BASE_USERS = [
  { name: 'Ann', posts: ['Hello', 'Second'] },
  { name: 'bob', posts: ['Bob post'] },
  { name: 'Cid', posts: [] },
  { name: 'Dora', posts: ['Dora 1', 'Dora 2'] },
  { name: 'Émile', posts: [] },
];

// Every case orders its query: sqlite :memory: has no cursor and pages by keyset, which needs an order.
export const STREAM_CASES = [
  defineCase({
    name: 'stream-batches',
    seed: manyUsers(25),
    order: 'ordered',
    expected: userNames(25),
    run: async () => {
      const names: string[] = [];
      for await (const user of CfUser.query().orderBy('Id').stream({ batchSize: 7 })) {
        names.push(user.Name);
      }
      return names;
    },
  }),
  defineCase({
    name: 'stream-break',
    seed: manyUsers(25),
    order: 'ordered',
    expected: { read: userNames(10), after: 25 },
    run: async () => {
      const names: string[] = [];
      for await (const user of CfUser.query().orderBy('Id').stream({ batchSize: 7 })) {
        names.push(user.Name);
        if (names.length === 10) {
          break;
        }
      }
      // a cursor or pool connection left open by the break would block or fail this query
      return { read: names, after: (await CfUser.all()).length };
    },
  }),
  defineCase({
    name: 'stream-populate',
    seed: BASE,
    order: 'ordered',
    expected: BASE_USERS,
    run: async () => {
      const out: Array<{ name: string; posts: string[] }> = [];
      for await (const user of CfUser.query().populate('Posts').orderBy('Id').stream({ batchSize: 2 })) {
        out.push({ name: user.Name, posts: sorted(user.Posts.map((p) => p.Title)) });
      }
      return out;
    },
  }),
  defineCase({
    name: 'stream-empty',
    seed: BASE,
    order: 'ordered',
    expected: [],
    run: async () => {
      const names: string[] = [];
      for await (const user of CfUser.where('Id', -1).orderBy('Id').stream({ batchSize: 5 })) {
        names.push(user.Name);
      }
      return names;
    },
  }),
  defineCase({
    name: 'stream-in-transaction',
    seed: BASE,
    order: 'ordered',
    expected: { read: BASE_USERS, written: BASE_USERS.map((u) => `${u.name}!`) },
    run: async ({ driver }) =>
      driver.transaction(async () => {
        const read: Array<{ name: string; posts: string[] }> = [];
        for await (const user of CfUser.query().populate('Posts').orderBy('Id').stream({ batchSize: 2 })) {
          // inside a transaction the stream pages by keyset and holds no cursor, so a write here does not wait for it
          await CfUser.update({ Name: `${user.Name}!` }).where('Id', user.Id);
          read.push({ name: user.Name, posts: sorted(user.Posts.map((p) => p.Title)) });
        }
        return { read, written: (await CfUser.query().orderBy('Id')).map((u) => u.Name) };
      }),
  }),
];
