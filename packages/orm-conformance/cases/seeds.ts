import { DateTime } from 'luxon';

import type { FixtureSeed } from '../src/index.js';

// Seeds go through the raw insert builder, which binds a JS Date through each driver's own, untested conversion. A
// zone-free timestamp literal means the same instant on every dialect ( the sessions run in UTC ).
const at = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).toFormat('yyyy-MM-dd HH:mm:ss.SSS');

/** Five users ( one with nulls, one with a non-ASCII name ), five posts of three users, three tags. */
export const BASE: FixtureSeed = {
  cf_users: [
    { Name: 'Ann', Email: 'ann@x.io', Age: 31, Active: true, Score: 12.5, CreatedAt: at('2026-01-10T08:00:00.000Z') },
    { Name: 'bob', Email: 'bob@x.io', Age: 25, Active: false, Score: 7.25, CreatedAt: at('2026-02-01T23:30:00.000Z') },
    { Name: 'Cid', Email: null, Age: null, Active: true, Score: null, CreatedAt: null },
    { Name: 'Dora', Email: 'dora@x.io', Age: 31, Active: true, Score: 99.99, CreatedAt: at('2026-03-15T12:00:00.000Z') },
    { Name: 'Émile', Email: 'emile@x.io', Age: 42, Active: false, Score: 0, CreatedAt: at('2025-12-31T23:59:59.000Z') },
  ],
  cf_tags: [{ Name: 'news' }, { Name: 'tech' }, { Name: 'misc' }],
  cf_posts: [
    { UserId: 1, Title: 'Hello', Views: 10, PublishedAt: at('2026-01-11T10:00:00.000Z') },
    { UserId: 1, Title: 'Second', Views: 0, PublishedAt: null },
    { UserId: 2, Title: 'Bob post', Views: 5, PublishedAt: at('2026-02-02T00:00:00.000Z') },
    { UserId: 4, Title: 'Dora 1', Views: 100, PublishedAt: at('2026-03-16T09:00:00.000Z') },
    { UserId: 4, Title: 'Dora 2', Views: 100, PublishedAt: at('2026-03-17T09:00:00.000Z') },
  ],
  cf_post_tags: [
    { PostId: 1, TagId: 1 },
    { PostId: 1, TagId: 2 },
    { PostId: 3, TagId: 2 },
    { PostId: 4, TagId: 1 },
    { PostId: 4, TagId: 3 },
  ],
};

export const EMPTY: FixtureSeed = {};
