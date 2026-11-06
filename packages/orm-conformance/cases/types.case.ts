import { DateTime } from 'luxon';

import { CfDoc, CfEvent, CfUser, defineCase } from '../src/index.js';
import { BASE, EMPTY } from './seeds.js';

const names = (users: CfUser[]) => users.map((u) => u.Name);

export const TYPE_CASES = [
  defineCase({
    name: 'datetime-roundtrip',
    seed: EMPTY,
    order: 'ordered',
    run: async () => {
      const created = await CfEvent.create({ Name: 'launch', At: DateTime.fromISO('2026-06-01T12:34:56.789+02:00', { setZone: true }) });
      return { at: (await CfEvent.get(created.Id)).At };
    },
  }),
  // The value's own calendar day is 2026-06-01; in UTC it is still 2026-05-31.
  defineCase({
    name: 'date-only',
    seed: EMPTY,
    order: 'ordered',
    run: async () => {
      const day = DateTime.fromISO('2026-06-01T00:30:00+14:00', { setZone: true });
      const created = await CfEvent.create({ Name: 'kiritimati', At: day, Day: day });
      return { day: (await CfEvent.get(created.Id)).Day };
    },
  }),
  defineCase({ name: 'where-datetime-range', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('CreatedAt', '>=', DateTime.fromISO('2026-02-01T00:00:00Z'))) }),
  defineCase({
    name: 'boolean-filter',
    seed: BASE,
    order: 'ordered',
    run: async () => (await CfUser.where('Active', true).orderBy('Id')).map((u) => ({ name: u.Name, active: u.Active })),
  }),
  defineCase({
    name: 'json-roundtrip',
    seed: EMPTY,
    order: 'ordered',
    run: async () => {
      const created = await CfDoc.create({ Label: 'doc', Body: { a: 1, list: [1, 'two', null], nested: { ok: true } } });
      return (await CfDoc.get(created.Id)).Body;
    },
  }),
  defineCase({ name: 'like-case', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Name', 'like', 'a%')) }),
  defineCase({ name: 'like-unicode', seed: BASE, order: 'unordered', run: async () => names(await CfUser.where('Name', 'like', 'é%')) }),
  defineCase({ name: 'unicode-order', seed: BASE, order: 'ordered', run: async () => names(await CfUser.query().orderBy('Name')) }),
];
