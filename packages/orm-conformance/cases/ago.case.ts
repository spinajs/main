import { DateTime } from 'luxon';

import { CfUser, defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

export const AGO_CASES = [
  defineCase({
    name: 'ago-cutoff',
    seed: EMPTY,
    order: 'unordered',
    // Written through the models, so each dialect stores the datetimes in the form the ORM writes.
    run: async ({ driver }) => {
      await CfUser.create({ Name: 'old', Active: true, CreatedAt: DateTime.utc().minus({ days: 10 }) });
      await CfUser.create({ Name: 'new', Active: true, CreatedAt: DateTime.utc().minus({ days: 1 }) });
      return (await CfUser.where('CreatedAt', '<', driver.ago(7, 'day'))).map((u) => u.Name);
    },
  }),
];
