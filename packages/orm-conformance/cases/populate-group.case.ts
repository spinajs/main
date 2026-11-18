import { RawQuery } from '@spinajs/orm';
import type { ISelectQueryBuilder, OrmDriver } from '@spinajs/orm';

import { CfComment, CfPost, CfUser, defineCase } from '../src/index.js';
import type { FixtureSeed } from '../src/index.js';
import { BASE } from './seeds.js';

type Row = Record<string, unknown>;

/** BASE plus one comment on Hello (Ann), one on Bob post (bob) and one on Dora 1 (Dora). */
const GROUP: FixtureSeed = {
  ...BASE,
  cf_comments: [
    { PostId: 1, Body: 'on Hello' },
    { PostId: 3, Body: 'on Bob post' },
    { PostId: 4, Body: 'on Dora 1' },
  ],
};

const ids = (rows: ReadonlyArray<{ Id: number }>) => rows.map((r) => r.Id).sort((a, b) => a - b);

// Flat in the parent WHERE, `Id = 1 AND Name = 'Ann' OR Name = 'bob'` would also keep bob's post 3.
const annOrBob = function (this: ISelectQueryBuilder) {
  this.where('Name', 'Ann').orWhere('Name', 'bob');
};

/** The rows of every statement `run` executes, before hydration: a relation query's over-read is invisible after it. */
async function rawRows(driver: OrmDriver, run: () => PromiseLike<unknown>): Promise<Row[][]> {
  const results: Row[][] = [];
  const execute = driver.execute.bind(driver);
  driver.execute = async (builder) => {
    const rows = (await execute(builder)) as Row[];
    results.push(rows);
    return rows;
  };

  try {
    await run();
  } finally {
    driver.execute = execute;
  }

  return results;
}

/** The o-15 probes: a populate callback's conditions reach the parent query as one group, on every dialect. */
export const POPULATE_GROUP_CASES = [
  defineCase({
    name: 'populate-group-or',
    seed: GROUP,
    order: 'ordered',
    run: async () => {
      const query = () => CfPost.where('Id', 1).populate('Author', annOrBob);
      const executed = query();
      const rows = ids(await executed);
      return { rows, cloneBefore: ids(await query().clone()), cloneAfter: ids(await executed.clone()) };
    },
  }),
  defineCase({
    name: 'populate-group-or-first',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.where('Id', 1).populate('Author', function () {
          this.orWhere('Name', 'bob');
        }),
      ),
  }),
  defineCase({
    name: 'populate-group-or-nested-where',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.where('Id', 1).populate('Author', function () {
          this.whereIn('Name', ['Ann']).orWhere(function () {
            this.where('Id', 2);
          });
        }),
      ),
  }),
  defineCase({
    name: 'populate-group-or-where-not',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.where('Id', 1).populate('Author', function () {
          this.where('Name', 'Ann').orWhere(function () {
            this.whereNot(function () {
              this.where('Name', 'Ann');
            });
          });
        }),
      ),
  }),
  defineCase({
    name: 'populate-group-or-true',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.where('Id', 1).populate('Author', function () {
          this.where('Name', 'zzz').orWhere(true);
        }),
      ),
  }),
  defineCase({
    name: 'populate-group-or-exists',
    seed: GROUP,
    order: 'ordered',
    run: async () => {
      const query = CfPost.where('Id', 1).populate('Author', function () {
        this.where('Name', 'zzz').orWhere(function () {
          this.whereExist('Posts', function () {
            this.where('Views', '>', 5);
          });
        });
      });
      const rows = ids(await query);
      return { rows, cloneAfter: ids(await query.clone()) };
    },
  }),
  defineCase({
    name: 'populate-group-nested-or',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfComment.where('Id', 2).populate('Post', function () {
          this.where('Title', 'Hello');
          this.populate('Author', function () {
            this.where('Name', 'zzz').orWhere('Name', 'Ann');
          });
        }),
      ),
  }),
  defineCase({
    name: 'populate-group-nested-outside-or',
    seed: GROUP,
    order: 'ordered',
    run: async () => {
      // ( Hello OR Bob post ) AND author: under the OR, `Hello OR Bob post AND author` keeps the Hello comment for any author
      const query = (author: string) =>
        CfComment.query().populate('Post', function () {
          this.where('Title', 'Hello').orWhere('Title', 'Bob post');
          this.populate('Author', function () {
            this.where('Name', author);
          });
        });
      const executed = query('bob');
      const bob = ids(await executed);
      return { none: ids(await query('zzz')), bob, bobCloneBefore: ids(await query('bob').clone()), bobCloneAfter: ids(await executed.clone()) };
    },
  }),
  defineCase({
    name: 'populate-group-second-populate',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.query()
          .populate('Author', annOrBob)
          .populate('Author', function () {
            this.where('Id', 2);
          }),
      ),
  }),
  defineCase({
    name: 'populate-group-relation-column',
    seed: GROUP,
    order: 'ordered',
    run: async () => ids(await CfPost.where('Author.Id', 1).populate('Author', annOrBob)),
  }),
  defineCase({
    name: 'populate-group-has-many-key-filter',
    seed: GROUP,
    order: 'ordered',
    run: async ({ driver }) => {
      // bob's posts: flat, `Hello OR Bob post AND UserId IN (2)` also reads Ann's Hello
      const [, children] = await rawRows(driver, () =>
        CfUser.where('Id', 2).populate('Posts', function () {
          this.where('Title', 'Hello').orWhere('Title', 'Bob post');
        }),
      );
      return children.map((r) => String(r.Title)).sort();
    },
  }),
  defineCase({
    name: 'populate-group-count',
    seed: GROUP,
    order: 'ordered',
    run: async () => CfPost.where('Id', 1).populate('Author', annOrBob).selectCount(),
  }),
  defineCase({
    name: 'populate-group-stream',
    seed: GROUP,
    order: 'ordered',
    run: async () => {
      const seen: number[] = [];
      for await (const post of CfPost.where('Views', '>', 5).orderBy('Id').populate('Author', annOrBob).stream({ batchSize: 1 })) {
        seen.push(post.Id);
        // flat, the OR returns post 1 on every keyset page: fail on the rows, not on the suite timeout
        if (seen.length > 5) {
          break;
        }
      }
      return seen;
    },
  }),
  defineCase({
    name: 'populate-group-many-to-many-key-filter',
    seed: GROUP,
    order: 'ordered',
    run: async ({ driver }) => {
      const [, junction] = await rawRows(driver, () =>
        CfPost.where('Id', 3).populate('Tags', function () {
          this.where('Name', 'tech').orWhere('Name', 'news');
        }),
      );
      // the driver nests the junction columns of a target row under JunctionModel
      return junction
        .map(({ JunctionModel: j }) => (typeof j === 'object' && j !== null && 'PostId' in j ? Number(j.PostId) : NaN))
        .sort((a, b) => a - b);
    },
  }),
  defineCase({
    name: 'populate-group-clone-narrowed',
    seed: GROUP,
    order: 'ordered',
    run: async () => {
      const query = CfPost.where('Id', 1).populate('Author', annOrBob);
      const copy = query.clone().where('Id', 2);
      return { original: ids(await query), copy: ids(await copy) };
    },
  }),
  defineCase({
    name: 'populate-group-raw-or',
    seed: GROUP,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.where('Id', 1).populate('Author', function () {
          this.where(RawQuery.create('1 = 0 OR 1 = 1'));
        }),
      ),
  }),
];

export const POPULATE_GROUP_EXPECTED: Readonly<Record<string, unknown>> = {
  'populate-group-or': { rows: [1], cloneBefore: [1], cloneAfter: [1] },
  'populate-group-or-first': [],
  'populate-group-or-nested-where': [1],
  'populate-group-or-where-not': [1],
  'populate-group-or-true': [1],
  'populate-group-or-exists': { rows: [1], cloneAfter: [1] },
  'populate-group-nested-or': [],
  'populate-group-nested-outside-or': { none: [], bob: [2], bobCloneBefore: [2], bobCloneAfter: [2] },
  // o-15 (ii), documented: the callback's OR also binds against what the relation query got elsewhere
  'populate-group-second-populate': [1, 2, 3],
  'populate-group-relation-column': [1, 2, 3],
  'populate-group-has-many-key-filter': ['Bob post'],
  'populate-group-count': 1,
  'populate-group-stream': [1],
  'populate-group-many-to-many-key-filter': [3],
  'populate-group-clone-narrowed': { original: [1], copy: [] },
  'populate-group-raw-or': [1],
};
