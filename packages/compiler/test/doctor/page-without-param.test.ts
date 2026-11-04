import 'mocha';
import { expect } from 'chai';
import type { RoutePagination } from '@spinajs/manifest';
import { pageWithoutParam } from '../../src/doctor/rules/page-without-param.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const item = { text: 'UserDto' };
const offset = (param?: RoutePagination['param']): RoutePagination => ({ kind: 'offset', item, ...(param ? { param } : {}) });

describe('HTTP007 page-without-param', () => {
  it('warns about a paginated route with no page parameter, at the subclass for an inherited one', () => {
    const m = fixture({
      controllers: [
        controller({
          className: 'Users',
          routes: [
            route({ handler: 'paged', pagination: offset({ arg: 'page', path: [] }) }),
            route({ handler: 'unpaged', pagination: offset(), source: src('src/users.ts', 9) }),
            route({ handler: 'cursor', pagination: { kind: 'cursor', item }, source: src('src/users.ts', 14) }),
            route({ handler: 'plain' }),
          ],
        }),
        controller({ className: 'Articles', source: src('src/articles.ts', 2), routes: [route({ handler: 'list', pagination: offset(), inheritedFrom: 'app:BaseCrud' })] }),
      ],
    });
    expect(pageWithoutParam.run(m, ctx).map((d) => [d.code, d.severity, d.message, d.source?.file, d.source?.line])).to.deep.equal([
      ['HTTP007', 'warning', 'Users.unpaged returns a page but has no page parameter (page): the generated client gets no infinite query for it.', 'src/users.ts', 9],
      ['HTTP007', 'warning', 'Users.cursor returns a page but has no page parameter (cursor or after): the generated client gets no infinite query for it.', 'src/users.ts', 14],
      ['HTTP007', 'warning', 'Articles.list (inherited from app:BaseCrud) returns a page but has no page parameter (page): the generated client gets no infinite query for it.', 'src/articles.ts', 2],
    ]);
  });

  it('repeats the HTTP007 the build reported for a page it could not mark, and no other build diagnostic', () => {
    const unmarked = { code: 'HTTP007', severity: 'warning' as const, message: 'Users.maybe returns a page inside a union', source: src('src/users.ts', 4) };
    const other = { code: 'SCH001', severity: 'warning' as const, message: 'unsupported type' };
    expect(pageWithoutParam.run(fixture({ diagnostics: [other, unmarked] }), ctx)).to.deep.equal([unmarked]);
  });
});
