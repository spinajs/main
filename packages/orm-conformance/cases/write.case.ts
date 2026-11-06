import { CfPost, CfTag, CfUser, defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

export const WRITE_CASES = [
  defineCase({
    name: 'insert-ids',
    seed: EMPTY,
    order: 'ordered',
    run: async () => {
      const created = await CfTag.create({ Name: 'created' });
      const inserted = new CfTag({ Name: 'inserted' });
      await inserted.insert();
      const saved = new CfTag({ Name: 'saved' });
      await saved.save();
      return [created.Id, inserted.Id, saved.Id];
    },
  }),
  defineCase({
    name: 'uow-graph',
    seed: EMPTY,
    order: 'ordered',
    run: async () => {
      const user = new CfUser({ Name: 'Graph', Active: true });
      user.Posts.add(new CfPost({ Title: 'g1', Views: 1 }));
      user.Posts.add(new CfPost({ Title: 'g2', Views: 2 }));
      await user.save();

      const read = await CfUser.query().where('Name', 'Graph').populate('Posts').firstOrFail();
      return { name: read.Name, posts: read.Posts.map((p) => p.Title).sort(), keys: user.Posts.map((p) => p.UserId === user.Id) };
    },
  }),
  defineCase({
    name: 'savepoint',
    seed: EMPTY,
    order: 'ordered',
    run: async ({ driver }) => {
      await driver.transaction(async () => {
        await CfTag.create({ Name: 'outer' });
        await driver
          .transaction(async () => {
            await CfTag.create({ Name: 'inner' });
            throw new Error('roll back the savepoint');
          })
          .catch(() => undefined);
      });
      return (await CfTag.all()).map((t) => t.Name);
    },
  }),
];
