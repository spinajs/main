import { CfVersioned, defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

const errorName = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

async function twoCopies(): Promise<[CfVersioned, CfVersioned]> {
  const created = await CfVersioned.create({ Name: 'original' });
  return [await CfVersioned.get(created.Id), await CfVersioned.get(created.Id)];
}

// the first copy's write stays, at version 2; the second copy's is refused
const STALE_WRITE = { error: 'OptimisticLockError', name: 'one', version: 2 };

export const VERSION_CASES = [
  defineCase({
    name: 'version-insert',
    seed: EMPTY,
    order: 'ordered',
    expected: { created: 1, stored: 1 },
    run: async () => {
      const created = await CfVersioned.create({ Name: 'a' });
      return { created: created.Version, stored: (await CfVersioned.get(created.Id)).Version };
    },
  }),
  defineCase({
    name: 'version-update-conflict',
    seed: EMPTY,
    order: 'ordered',
    expected: STALE_WRITE,
    run: async () => {
      const [one, two] = await twoCopies();
      one.Name = 'one';
      await one.update();
      two.Name = 'two';
      const error = await two.update().then(() => 'none', errorName);
      const stored = await CfVersioned.get(one.Id);
      return { error, name: stored.Name, version: stored.Version };
    },
  }),
  defineCase({
    name: 'version-save-conflict',
    seed: EMPTY,
    order: 'ordered',
    expected: STALE_WRITE,
    run: async () => {
      const [one, two] = await twoCopies();
      one.Name = 'one';
      await one.save();
      two.Name = 'two';
      const error = await two.save().then(() => 'none', errorName);
      const stored = await CfVersioned.get(one.Id);
      return { error, name: stored.Name, version: stored.Version };
    },
  }),
  defineCase({
    name: 'version-destroy-stale',
    seed: EMPTY,
    order: 'ordered',
    expected: { error: 'OptimisticLockError', rows: 1 },
    run: async () => {
      const [one, two] = await twoCopies();
      one.Name = 'one';
      await one.update();
      const error = await two.destroy().then(() => 'none', errorName);
      return { error, rows: (await CfVersioned.all()).length };
    },
  }),
];
