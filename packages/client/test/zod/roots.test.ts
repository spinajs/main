import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, emitZod } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { serverAccepts, validatorFor } from '../support/server.js';
import { clearLoaded, loadZod, manifestWith, route, type SafeParse } from '../support/zod.js';

const cap = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

const DEEP = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };

// The data of a validation root has no parent to assign into, so a coerced infinity there is not left in the data.
const ROOTS: Record<string, unknown> = {
  allOf: { allOf: [{ type: 'string', not: { type: 'number' } }] },
  anyOf: { anyOf: [{ type: 'string', not: { type: 'number' } }, { type: 'null' }] },
  oneOf: { oneOf: [{ type: 'string', not: { type: 'number' } }, { type: 'null' }] },
  not: { not: { type: 'number' } },
  notString: { type: 'string', not: { type: 'number' } },
  cond: { if: { type: 'number' }, then: { minimum: -1000 } },
  thread: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  deep: { not: DEEP },
  deepOneOf: { oneOf: [DEEP, { type: 'string' }] },
  ref: { $ref: 'test/NumI' },
  refMember: { allOf: [{ $ref: 'test/NumI' }] },
};

const VALUES: unknown[] = [
  '', '0', 0, '5', 5, null, 'null', false, 'false', true, 'true', [null], ['0'], ['5'], [], 'a', {}, 'Infinity', '-Infinity', '1e400', ['Infinity'], ' 1e400 ', { n: 'Infinity' }, { n: '1e400', x: 1 },
  { n: 5 }, { x: 'Infinity' }, ['x', 'Infinity'],
];

describe('emitZod: coerced infinities at the root of a validation', function () {
  this.timeout(60000);

  let manifest: Manifest;

  before(async () => {
    const extra = { 'test/NumI': { type: 'number', minimum: -5 }, ...Object.fromEntries(Object.entries(ROOTS).map(([name, schema]) => [`test/Root${cap(name)}`, schema])) };
    const args = Object.keys(ROOTS).map((name, i) => ({
      index: i,
      name,
      kind: 'FromQuery',
      runtimeType: { text: `Root${cap(name)}`, ref: { package: 'global', file: '', export: 'Object' }, schema: `test/Root${cap(name)}` },
      required: true,
      wire: { in: 'query' as const, name, shape: 'json' as const },
    }));
    manifest = manifestWith(await appBasicManifest(), {}, extra, [route('roots', 'get', args)]);
  });

  after(clearLoaded);

  for (const mini of [false, true]) {
    describe(mini ? 'zod/mini' : 'zod', () => {
      let roots: Record<string, SafeParse>;

      before(async () => {
        const module = await loadZod(emitZod(buildClientModel(manifest), { mini }).contents);
        roots = (module.routeSchemas as Record<string, Record<string, Record<string, SafeParse>>>).items.roots;
      });

      for (const name of Object.keys(ROOTS)) {
        it(`answers as the server for the root ${name}: ${JSON.stringify(ROOTS[name])}`, () => {
          const server = validatorFor(manifest);
          for (const v of VALUES) {
            expect(roots[name].safeParse(v).success, `${name} on ${JSON.stringify(v)}`).to.equal(serverAccepts(server, `test/Root${cap(name)}`, { coerce: true }, v));
          }
        });
      }
    });
  }
});
