import type { IWhereBuilder } from '@spinajs/orm';

import { CfPost, CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const ids = (rows: ReadonlyArray<{ Id: number }>) => rows.map((r) => r.Id).sort((a, b) => a - b);

// Flat, `Title = ? OR Title = ? AND UserId = users.Id` matches bob's post for every user.
const bobPostOrNone = function (this: IWhereBuilder<unknown>) {
  this.where('Title', 'Bob post').orWhere('Title', 'none');
};

const bobOrNone = function (this: IWhereBuilder<unknown>) {
  this.where('Name', 'bob').orWhere('Name', 'none');
};

/** An OR in a whereExist() / whereNotExists() callback stays inside the sub-select's correlation, on every dialect. */
export const WHERE_EXIST_GROUP_CASES = [
  defineCase({
    name: 'where-exist-or-has-many',
    seed: BASE,
    order: 'ordered',
    run: async () => {
      const query = () => CfUser.where('Id', 1).whereExist('Posts', bobPostOrNone);
      const executed = query();
      const rows = ids(await executed);
      return { rows, cloneBefore: ids(await query().clone()), cloneAfter: ids(await executed.clone()), all: ids(await CfUser.query().whereExist('Posts', bobPostOrNone)) };
    },
  }),
  defineCase({
    name: 'where-not-exists-or-has-many',
    seed: BASE,
    order: 'ordered',
    run: async () => ids(await CfUser.query().whereNotExists('Posts', bobPostOrNone)),
  }),
  defineCase({
    name: 'where-exist-or-belongs-to',
    seed: BASE,
    order: 'ordered',
    run: async () => ids(await CfPost.query().whereExist('Author', bobOrNone)),
  }),
  defineCase({
    name: 'where-not-exists-or-belongs-to',
    seed: BASE,
    order: 'ordered',
    run: async () => ids(await CfPost.query().whereNotExists('Author', bobOrNone)),
  }),
  defineCase({
    name: 'where-exist-or-lazy-populate',
    seed: BASE,
    order: 'ordered',
    run: async () => {
      const ann = await CfUser.where('Id', 1).firstOrFail();
      await ann.Posts.populate(function () {
        this.whereExist('Author', bobOrNone);
      });
      return ids(ann.Posts);
    },
  }),
  defineCase({
    name: 'where-exist-or-many-to-many',
    seed: BASE,
    order: 'ordered',
    run: async () =>
      ids(
        await CfPost.query().whereExist('Tags', function () {
          this.where('Name', 'misc').orWhere('Name', 'none');
        }),
      ),
  }),
];

export const WHERE_EXIST_GROUP_EXPECTED: Record<string, unknown> = {
  'where-exist-or-has-many': { rows: [], cloneBefore: [], cloneAfter: [], all: [2] },
  'where-not-exists-or-has-many': [1, 3, 4, 5],
  'where-exist-or-belongs-to': [3],
  'where-not-exists-or-belongs-to': [1, 2, 4, 5],
  'where-exist-or-lazy-populate': [],
  'where-exist-or-many-to-many': [4],
};
