import 'mocha';
import { expect } from 'chai';
import { mswPaths } from '../src/generate/msw.js';

describe('mswPaths (Express 5 to MSW path syntax)', () => {
  const cases: [string, string, string[]][] = [
    ['a static path', '/health', ['/health']],
    ['a named parameter', '/users/:id', ['/users/:id']],
    ['two parameters', '/a/:x/b/:y', ['/a/:x/b/:y']],
    ['a parameter next to literal text', '/v1.0/a-:id', ['/v1.0/a-:id']],
    ['an optional group', '/a{/:id}', ['/a/:id', '/a']],
    ['an optional group in the middle', '/a{/:id}/b', ['/a/:id/b', '/a/b']],
    ['two optional groups', '/a{/:id}{/:sub}', ['/a/:id/:sub', '/a/:id', '/a/:sub', '/a']],
    ['a nested optional group', '/a{/:id{/:sub}}', ['/a/:id/:sub', '/a/:id', '/a']],
    ['a group at the root', '{/:id}', ['/:id', '/']],
    ['a wildcard', '/files/*path', ['/files/*']],
    ['an optional wildcard', '/files{/*path}', ['/files/*', '/files']],
    ['wildcards around literal text', '/x/*a/y/*b', ['/x/*/y/*']],
    ['an escaped colon', '/a\\:b', ['/a\\:b']],
    ['an escaped asterisk', '/a\\*b', ['/a\\*b']],
    ['an escaped question mark, which MSW would read as a query', '/a/b\\?c', ['/a/b%3Fc']],
    ['an escaped backslash, which MSW would read as an escape', '/a/b\\\\c', ['/a/b\\\\c']],
    ['an escaped brace', '/a\\{b\\}', ['/a{b}']],
    ['a quoted parameter name MSW can read', '/a/:"id"', ['/a/:id']],
  ];

  for (const [name, express, expected] of cases) {
    it(`translates ${name}`, () => {
      expect(mswPaths(express)).to.deep.equal(expected);
    });
  }

  it('refuses a parameter name MSW cannot read', () => {
    expect(() => mswPaths('/a/:"my-id"')).to.throw(/parameter name 'my-id'/);
    expect(() => mswPaths('/a/:$id')).to.throw(/parameter name '\$id'/);
  });

  it('refuses the syntax Express 5 refuses', () => {
    expect(() => mswPaths('/a/(b)')).to.throw(/reserved/);
  });
});
