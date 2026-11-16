import 'mocha';
import { expect } from 'chai';
import type { Manifest, ParamEntry } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClient, type ZodEmitResult } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { serverAccepts, validatorFor } from '../support/server.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, route, schemaIn, type SafeParse } from '../support/zod.js';

const cap = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

// Each field gets its own one-field root too, so a value that only that field decides is checked on its own.
const FIELDS: Record<string, unknown> = {
  nullRef: { anyOf: [{ $ref: 'test/Page' }, { type: 'null' }] },
  nullInline: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  nullEnum: { anyOf: [{ $ref: 'test/Status' }, { type: 'null' }] },
  nullFirst: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
  mutated: { anyOf: [{ type: 'integer', minimum: 10 }, { type: 'boolean' }] },
  mutatedRef: { anyOf: [{ $ref: 'test/Big' }, { type: 'boolean' }] },
  oneMutated: { oneOf: [{ type: 'integer', minimum: 10 }, { type: 'boolean' }] },
  oneRef: { oneOf: [{ $ref: 'test/Page' }, { type: 'string', maxLength: 0 }] },
  unique: { type: 'array', items: { type: 'number' }, uniqueItems: true },
  nestedRef: { anyOf: [{ $ref: 'test/Nested' }, { type: 'string', pattern: '^0' }] },
};

// Values as a query string carries them; the non-finite ones are refused by the fixed server only.
const VALUES: unknown[] = ['', '0', '05', 0, '1', 1, '5', 5, '12', 12, null, 'null', false, 'false', true, 'true', [null], ['0'], ['5'], ['1', 1], [], 'a', 'b', ['a'], {}, [1, '1'], [1, 2]];

const EXTRA: Record<string, unknown> = {
  'test/Page': { type: 'integer', minimum: 1 },
  'test/Big': { type: 'integer', minimum: 10 },
  // Ajv compiles a target that holds a $ref apart: its coercion does not reach the branch after it.
  'test/Nested': { type: 'integer', minimum: 10, not: { $ref: 'test/Zero' } },
  'test/Zero': { type: 'integer', const: 999 },
  'test/Status': { type: 'string', enum: ['a', 'b'] },
  'test/Query': object({
    page: { type: 'integer', minimum: 1 },
    flag: { type: 'boolean' },
    ids: { type: 'array', items: { type: 'number' } },
    q: { type: ['string', 'null'] },
    nested: { $ref: 'test/Inner' },
    atLeast: { allOf: [{ type: 'number' }, { minimum: 1 }] },
    both: { allOf: [{ type: 'object', properties: { a: { type: 'number' } } }, { type: 'object', properties: { b: { type: 'string' } } }] },
  }),
  'test/Inner': object({ n: { type: 'number' } }),
  'test/get_id': { type: 'number', minimum: 1 },
  'test/get_flag': { type: 'boolean' },
  'test/get_name': { type: 'string', minLength: 2 },
  'test/get_big': { type: 'string', pattern: '^-?[0-9]+$' },
  ...Object.fromEntries(Object.entries(FIELDS).map(([name, schema]) => [`test/Field${cap(name)}`, object({ v: schema }, { required: ['v'] })])),
};

function scalar(index: number, name: string, kind: string, runtime: string, schema: string): ParamEntry {
  const runtimeType = { text: runtime.toLowerCase(), ref: { package: 'global', file: '', export: runtime }, schema };
  return { index, name, kind, runtimeType, required: true, wire: { in: kind === 'FromParams' ? 'path' : 'query', name, shape: 'value' } };
}

const json = (index: number, name: string, kind: string, schema: string, shape: 'json' | 'whole'): ParamEntry => ({
  index,
  name,
  kind,
  runtimeType: { text: schema.slice(schema.indexOf('/') + 1), ref: { package: 'global', file: '', export: 'Object' }, schema },
  required: true,
  wire: { in: 'query', ...(shape === 'json' ? { name } : {}), shape },
});

const ROUTES = [
  route('list', 'get', [json(0, 'query', 'FromQuery', 'test/Query', 'json')]),
  route('search', 'get', [json(0, 'all', 'QueryFieldRouteArgs', 'test/Query', 'whole')]),
  route('get', 'get', [
    scalar(0, 'id', 'FromParams', 'Number', 'test/get_id'),
    scalar(1, 'flag', 'FromQuery', 'Boolean', 'test/get_flag'),
    scalar(2, 'name', 'FromQuery', 'String', 'test/get_name'),
    scalar(3, 'big', 'FromQuery', 'BigInt', 'test/get_big'),
  ]),
  route('fields', 'get', Object.keys(FIELDS).map((name, i) => json(i, name, 'FromQuery', `test/Field${cap(name)}`, 'json'))),
];

const NAMED = {
  Defaulted: object({ page: { type: 'number', default: 1 }, tags: { type: 'array', items: { type: 'string' }, default: ['a'] }, name: { type: 'string' } }),
  Plain: { type: 'string' },
};

describe('emitZod: coerced variants, scalar arguments and defaults', function () {
  this.timeout(60000);

  let manifest: Manifest;
  let client: string;

  before(async () => {
    manifest = manifestWith(await appBasicManifest(), NAMED, EXTRA, ROUTES);
    client = await generateClient({ manifest });
  });

  after(clearLoaded);

  for (const mini of [false, true]) {
    describe(mini ? 'zod/mini' : 'zod', () => {
      let result: ZodEmitResult;
      let module: Record<string, unknown>;
      const routes = () => module.routeSchemas as Record<string, Record<string, Record<string, SafeParse>>>;

      before(async () => {
        result = emitZod(buildClientModel(manifest), { mini });
        module = await loadZod(result.contents);
      });

      it('type-checks against the interfaces of client.ts', () => {
        expect(typecheckFiles({ 'client.ts': `${client}export const manifestHash = '${manifest.hash}';\n`, 'client.zod.ts': result.contents }, { noUnusedLocals: true })).to.deep.equal([]);
      });

      it('checks query, path, header and cookie values against <Name>Coerced, a JSON-shaped query too', () => {
        const server = validatorFor(manifest, false);
        const coerced = [{ page: '2', flag: 'true', ids: '5', q: '', nested: { n: '1' } }, { page: ['3'] }, { flag: 0, q: null }];
        for (const value of coerced) {
          expect(routes().items.list.query.safeParse(value).success, JSON.stringify(value)).to.equal(true);
          expect(serverAccepts(server, 'test/Query', { coerce: true }, value)).to.equal(true);
          expect(schemaIn(module, 'QuerySchema').safeParse(value).success).to.equal(false);
        }
        expect(routes().items.list.query.safeParse(coerced[0]).data).to.deep.equal({ page: 2, flag: true, ids: [5], q: '', nested: { n: 1 } });
        for (const value of [{ page: '1.5' }, { flag: 'yes' }, { extra: 1 }, { nested: { n: 'x' } }]) {
          expect(routes().items.list.query.safeParse(value).success, JSON.stringify(value)).to.equal(false);
          expect(serverAccepts(server, 'test/Query', { coerce: true }, value)).to.equal(false);
        }
        expect(result.contents).to.include('query: QueryCoerced,');
        expect(result.contents).to.include('export const InnerCoerced');
      });

      // anyOf with { type: 'null' } coerces '', 0 and false to null, and a failing branch leaves the value it coerced.
      for (const name of Object.keys(FIELDS)) {
        it(`answers as the server for ${name}: ${JSON.stringify(FIELDS[name])}`, () => {
          const server = validatorFor(manifest, false);
          const schema = routes().items.fields[name];
          for (const v of VALUES) {
            const verdict = serverAccepts(server, `test/Field${cap(name)}`, { coerce: true }, { v });
            expect(schema.safeParse({ v }).success, `${name} on ${JSON.stringify(v)}`).to.equal(verdict);
          }
        });
      }

      it('joins allOf parts that coerce differently instead of throwing, as Ajv coerces them in turn', () => {
        const query = routes().items.list.query;
        expect(query.safeParse({ atLeast: '5', both: { a: '1', b: 2 } }).data).to.deep.equal({ atLeast: 5, both: { a: 1, b: '2' } });
        for (const value of [{ atLeast: '0' }, { both: { a: 'x' } }]) {
          expect(() => query.safeParse(value)).to.not.throw();
          expect(query.safeParse(value).success, JSON.stringify(value)).to.equal(false);
          expect(serverAccepts(validatorFor(manifest, false), 'test/Query', { coerce: true }, value)).to.equal(false);
        }
      });

      it('refuses a recursive array union at the root instead of overflowing the stack', async () => {
        const recursive = manifestWith(manifest, {}, { 'test/Tree': { anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: 'test/Tree' } }] } }, [
          route('tree', 'get', [json(0, 'tree', 'FromQuery', 'test/Tree', 'json')]),
        ]);
        const { contents } = emitZod(buildClientModel(recursive), { mini });
        const pair = { 'client.ts': `${await generateClient({ manifest: recursive })}export const manifestHash = '${recursive.hash}';
`, 'client.zod.ts': contents };
        expect(typecheckFiles(pair, { noUnusedLocals: true })).to.deep.equal([]);
        const tree = ((await loadZod(contents)).routeSchemas as Record<string, Record<string, Record<string, SafeParse>>>).items.tree.tree;
        for (const value of ['x', '', ['x'], [['y']]]) {
          expect(() => tree.safeParse(value), JSON.stringify(value)).to.not.throw();
          expect(tree.safeParse(value).success, JSON.stringify(value)).to.equal(false);
        }
        for (const value of ['5', 5, [], [[]], ['5'], [['5', 6]]]) expect(tree.safeParse(value).success, JSON.stringify(value)).to.equal(true);
      });

      it('refuses a coerced infinity, as the fixed server does', () => {
        for (const page of ['Infinity', '-Infinity', '1e400']) expect(routes().items.list.query.safeParse({ page }).success, page).to.equal(false);
      });

      it('keeps a whole query root open', () => {
        expect(routes().items.search.all.safeParse({ page: '2', other: 'x' }).success).to.equal(true);
        expect(serverAccepts(validatorFor(manifest, false), 'test/Query', { coerce: true, openRoot: true }, { page: '2', other: 'x' })).to.equal(true);
      });

      it('converts a scalar argument by its runtime type first, as RouteArgs does', () => {
        const { id, flag, name, big } = routes().items.get;
        expect(['5', 5, ' 7 ', '', null, undefined].map((v) => id.safeParse(v).success)).to.deep.equal([true, true, true, true, true, true]);
        expect(['abc', '0', 'Infinity', [1, 2]].map((v) => id.safeParse(v).success)).to.deep.equal([false, false, false, false]);
        expect(id.safeParse(' 7 ').data).to.equal(7);
        expect(['yes', 'TRUE', 0].map((v) => flag.safeParse(v).data)).to.deep.equal([false, true, false]);
        expect(['ab', 12, null, undefined].map((v) => name.safeParse(v).success)).to.deep.equal([true, true, true, true]);
        expect(name.safeParse('a').success).to.equal(false);
        expect(['12', '0x10', true].map((v) => big.safeParse(v).success)).to.deep.equal([true, true, true]);
        expect(['1.5', undefined].map((v) => big.safeParse(v).success)).to.deep.equal([false, false]);
      });

      it('exports the defaults of an object schema for a form, and none for other schemas', () => {
        expect(result.contents).to.include('export const DefaultedDefaults: Partial<Defaulted> = {\n  page: 1,\n  tags: ["a"],\n};');
        expect(module.DefaultedDefaults).to.deep.equal({ page: 1, tags: ['a'] });
        expect(module.PlainDefaults).to.equal(undefined);
      });

      it('names <Name>Defaults clear of a schema that already takes the name', async () => {
        const named = manifestWith(manifest, { Foo: object({ a: { type: 'number', default: 1 } }), FooDefaults: object({ b: { type: 'string' } }) });
        const contents = emitZod(buildClientModel(named), { mini }).contents;
        expect(contents).to.include('export const FooDefaults2: Partial<Foo> = {');
        const pair = { 'client.ts': `${await generateClient({ manifest: named })}export const manifestHash = '${named.hash}';\n`, 'client.zod.ts': contents };
        expect(typecheckFiles(pair, { noUnusedLocals: true })).to.deep.equal([]);
      });

      // Their own manifests, without a type check: client.ts misnames a dotted id such as authn.Login, which is not this task's.
      it('gives a strict id (authn., authz.) no Coerced variant as an argument, which DataValidator validates', async () => {
        const strict = manifestWith(manifest, {}, { 'authn.Login': object({ n: { type: 'number' }, inner: { $ref: 'test/Inner' } }), 'test/Inner': EXTRA['test/Inner'] }, [
          route('login', 'get', [json(0, 'login', 'FromQuery', 'authn.Login', 'json')]),
        ]);
        const { contents } = emitZod(buildClientModel(strict), { mini });
        expect(contents).to.not.include('Coerced');
        const login = ((await loadZod(contents)).routeSchemas as Record<string, Record<string, Record<string, SafeParse>>>).items.login.login;
        expect(login.safeParse({ n: '1' }).success).to.equal(false);
        expect(login.safeParse({ n: 1, inner: { n: 2 } }).success).to.equal(true);
      });

      it('coerces a strict id nested in a derived query, as ManifestValidator does', async () => {
        const nested = manifestWith(manifest, {}, { 'test/Outer': object({ login: { $ref: 'authn.Login' } }), 'authn.Login': object({ n: { type: 'number' } }) }, [
          route('outer', 'get', [json(0, 'outer', 'FromQuery', 'test/Outer', 'json')]),
        ]);
        const { contents } = emitZod(buildClientModel(nested), { mini });
        const outer = ((await loadZod(contents)).routeSchemas as Record<string, Record<string, Record<string, SafeParse>>>).items.outer.outer;
        expect(outer.safeParse({ login: { n: '1' } }).success).to.equal(true);
        expect(serverAccepts(validatorFor(nested, false), 'test/Outer', { coerce: true }, { login: { n: '1' } })).to.equal(true);
      });
    });
  }
});
