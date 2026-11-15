import { CfPost, CfUser, defineCase } from '../src/index.js';
import { BASE } from './seeds.js';

const sorted = (values: string[]) => [...values].sort();

export const POPULATE_CASES = [
  defineCase({
    name: 'populate-has-many',
    seed: BASE,
    order: 'ordered',
    run: async () => (await CfUser.query().populate('Posts').orderBy('Id')).map((u) => ({ name: u.Name, posts: sorted(u.Posts.map((p) => p.Title)) })),
  }),
  defineCase({
    name: 'populate-belongs-to',
    seed: BASE,
    order: 'ordered',
    run: async () => (await CfPost.query().populate('Author').orderBy('Id')).map((p) => ({ title: p.Title, author: p.Author.Value?.Name ?? null })),
  }),
  defineCase({
    name: 'populate-many-to-many',
    seed: BASE,
    order: 'ordered',
    run: async () => (await CfPost.query().populate('Tags').orderBy('Id')).map((p) => ({ title: p.Title, tags: sorted(p.Tags.map((t) => t.Name)) })),
  }),
  defineCase({
    name: 'populate-nested',
    seed: BASE,
    order: 'ordered',
    run: async () =>
      (
        await CfUser.query()
          .populate('Posts', function () {
            this.populate('Tags');
          })
          .orderBy('Id')
      ).map((u) => ({
        name: u.Name,
        posts: u.Posts.map((p) => ({ title: p.Title, tags: sorted(p.Tags.map((t) => t.Name)) })).sort((a, b) => (a.title < b.title ? -1 : 1)),
      })),
  }),
  defineCase({
    name: 'populate-filtered',
    seed: BASE,
    order: 'ordered',
    run: async () =>
      (
        await CfUser.query()
          .populate('Posts', function () {
            this.where('Views', '>', 5);
          })
          .orderBy('Id')
      ).map((u) => ({ name: u.Name, posts: sorted(u.Posts.map((p) => p.Title)) })),
  }),
];
