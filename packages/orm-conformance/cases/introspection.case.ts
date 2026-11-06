import type { LiveForeignKey, LiveIndex } from '@spinajs/orm';

import { defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

// Auto-named indexes ( a primary key's, a unique column's, MySQL's index per foreign key ) differ per dialect:
// only the primary key and the indexes this case names are compared.
const named = (indexes: LiveIndex[]) => indexes.filter((i) => i.primary || /^(ix|uq)_/.test(i.name)).map((i) => ({ ...i, name: i.primary ? 'PRIMARY' : i.name }));

const unnamed = (keys: LiveForeignKey[]) =>
  keys.map((k) => ({ column: k.column, table: k.table, references: k.references, onDelete: k.onDelete ?? null, onUpdate: k.onUpdate ?? null })).sort((a, b) => (a.column < b.column ? -1 : 1));

export const INTROSPECTION_CASES = [
  defineCase({
    name: 'introspection',
    seed: EMPTY,
    order: 'ordered',
    run: async ({ driver }) => {
      const indexesOf = driver.tableIndexes?.bind(driver);
      const keysOf = driver.tableForeignKeys?.bind(driver);
      if (!indexesOf || !keysOf) {
        return 'unsupported';
      }

      await driver.index().name('ix_posts_user_views').table('cf_posts').columns(['UserId', 'Views']);
      await driver.index().unique().name('uq_tags_name').table('cf_tags').columns(['Name']);

      return {
        users: named(await indexesOf('cf_users')),
        posts: named(await indexesOf('cf_posts')),
        tags: named(await indexesOf('cf_tags')),
        postKeys: unnamed(await keysOf('cf_posts')),
        postTagKeys: unnamed(await keysOf('cf_post_tags')),
      };
    },
  }),
];
