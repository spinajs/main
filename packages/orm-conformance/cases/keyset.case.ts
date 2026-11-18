import type { IKeysetPageOptions, KeysetPage } from '@spinajs/orm';

import { CfPost, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

type Order = IKeysetPageOptions<CfPost>['orderBy'];

const MAX_PAGES = 50;
const titles = (page: KeysetPage<CfPost>) => page.items.map((p) => p.Title);

async function walkForward(orderBy: Order, limit: number, after?: string): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor = after;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await CfPost.query().paginate({ orderBy, limit, after: cursor });
    pages.push(titles(page));
    if (page.next === null) {
      return pages;
    }
    cursor = page.next;
  }
  throw new Error(`keyset walk did not end within ${MAX_PAGES} pages`);
}

async function walkBackward(orderBy: Order, limit: number): Promise<string[][]> {
  let page = await CfPost.query().paginate({ orderBy, limit });
  for (let i = 0; i < MAX_PAGES && page.next !== null; i++) {
    page = await CfPost.query().paginate({ orderBy, limit, after: page.next });
  }

  const pages = [titles(page)];
  for (let i = 0; i < MAX_PAGES && page.previous !== null; i++) {
    page = await CfPost.query().paginate({ orderBy, limit, before: page.previous });
    pages.push(titles(page));
  }
  return pages;
}

// BASE posts by Views descending, ties by key: Dora 1 (100), Dora 2 (100), Hello (10), Bob post (5), Second (0).
const BY_VIEWS = [['Dora 1', 'Dora 2'], ['Hello', 'Bob post'], ['Second']];

// Numeric order columns only: text order differs by collation per target (see unicode-order in divergences.json).
export const KEYSET_CASES = [
  defineCase({ name: 'keyset-forward', seed: BASE, order: 'ordered', expected: BY_VIEWS, run: () => walkForward([['Views', 'desc']], 2) }),
  defineCase({ name: 'keyset-backward', seed: BASE, order: 'ordered', expected: [...BY_VIEWS].reverse(), run: () => walkBackward([['Views', 'desc']], 2) }),
  defineCase({
    name: 'keyset-mixed',
    seed: BASE,
    order: 'ordered',
    expected: [['Hello', 'Second'], ['Bob post', 'Dora 1'], ['Dora 2']],
    run: () =>
      walkForward(
        [
          ['UserId', 'asc'],
          ['Views', 'desc'],
        ],
        2,
      ),
  }),
  defineCase({
    name: 'keyset-insert-between',
    seed: BASE,
    order: 'ordered',
    expected: BY_VIEWS,
    run: async () => {
      const orderBy: Order = [['Views', 'desc']];
      const first = await CfPost.query().paginate({ orderBy, limit: 2 });
      // sorts before the cursor: the walk must neither repeat a row nor show this one
      await CfPost.create({ UserId: 1, Title: 'Late top', Views: 1000 });
      return [titles(first), ...(first.next === null ? [] : await walkForward(orderBy, 2, first.next))];
    },
  }),
  defineCase({
    name: 'keyset-invalid-cursor',
    seed: BASE,
    order: 'ordered',
    expected: 'InvalidCursor',
    run: async () => {
      const first = await CfPost.query().paginate({ orderBy: [['Views', 'desc']], limit: 2 });
      try {
        await CfPost.query().paginate({ orderBy: [['Id', 'asc']], limit: 2, after: first.next ?? '' });
        return 'accepted';
      } catch (err) {
        return err instanceof Error ? err.constructor.name : typeof err;
      }
    },
  }),
];
