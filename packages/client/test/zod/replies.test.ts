import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClientFiles } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { matchesSnapshot as compareSnapshot } from '../support/snapshot.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, route } from '../support/zod.js';

const snapshot = (name: string) => fileURLToPath(new URL(`../__snapshots__/zod/${name}`, import.meta.url));

const matchesSnapshot = (name: string, contents: string): void => compareSnapshot(snapshot(name), contents);

const replying = (handler: string, text: string, schema?: string): RouteEntry => ({ ...route(handler, 'get', []), returnType: { text, ...(schema ? { schema } : {}) } });

const dto = {
  type: 'object',
  properties: { a: { type: 'string' }, inner: { $ref: 'test/Inner' }, tags: { type: 'array', items: { $ref: 'test/Inner' } } },
  required: ['a'],
  additionalProperties: false,
};
const inner = { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false };
const open = { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] };
const needsB = { type: 'object', properties: { a: { type: 'string' } }, required: ['b'], additionalProperties: false };
const node = { type: 'object', properties: { name: { type: 'string' }, child: { $ref: 'test/Node' } }, required: ['name'], additionalProperties: false };
const strict = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
const strict2 = { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false };
const oneOf = { type: 'object', properties: { f: { oneOf: [{ $ref: 'test/Strict' }, { $ref: 'test/Strict2' }] } }, additionalProperties: false };
const a1 = { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'string' } }, required: ['kind'], additionalProperties: false };
const a2 = { type: 'object', properties: { kind: { enum: ['a', 'b'] } }, required: ['kind'] };
const disc = { oneOf: [{ $ref: 'test/A1' }, { $ref: 'test/A2' }], 'x-discriminator': { propertyName: 'kind' } };
const user = { type: 'object', properties: { id: { type: 'number' }, email: { type: 'string' } }, required: ['id', 'email'], additionalProperties: false };
const admin = { type: 'object', properties: { id: { type: 'number' }, email: { type: 'string' }, role: { type: 'string' } }, required: ['id', 'email', 'role'], additionalProperties: false };
const either = { anyOf: [{ $ref: 'test/User' }, { $ref: 'test/Admin' }] };
const list = { type: 'array', items: { $ref: 'test/Dto' } };

async function fixture(): Promise<Manifest> {
  const routes = [
    replying('read', 'Dto', 'test/Dto'),
    replying('list', 'unknown', 'test/List'),
    replying('open', 'Open', 'test/Open'),
    replying('needsB', 'NeedsB', 'test/NeedsB'),
    replying('tree', 'Node', 'test/Node'),
    replying('oneOf', 'OneOf', 'test/OneOf'),
    replying('disc', 'Disc', 'test/Disc'),
    replying('either', 'Either', 'test/Either'),
    replying('count', 'number'),
    route('remove', 'delete', []),
  ];
  return manifestWith(await appBasicManifest(), {}, { 'test/Dto': dto, 'test/Inner': inner, 'test/Open': open, 'test/NeedsB': needsB, 'test/Node': node, 'test/List': list, 'test/Strict': strict, 'test/Strict2': strict2, 'test/OneOf': oneOf, 'test/A1': a1, 'test/A2': a2, 'test/Disc': disc, 'test/User': user, 'test/Admin': admin, 'test/Either': either }, routes);
}

type Parser = { parse(value: unknown): unknown };

describe('client.zod.ts reply schemas (replies: true)', function () {
  this.timeout(120000);

  let manifest: Manifest;
  let contents: string;
  let module: Record<string, unknown>;

  before(async () => {
    manifest = await fixture();
    contents = emitZod(buildClientModel(manifest), { replies: true }).contents;
    module = await loadZod(contents);
  });

  after(clearLoaded);

  const schema = (name: string): Parser => module[name] as Parser;
  const replies = () => module.replySchemas as Record<string, Record<string, Parser>>;

  it('is off by default: the file has no reply schemas', () => {
    const plain = emitZod(buildClientModel(manifest), {}).contents;
    expect(plain).to.not.include('Reply');
    expect(plain).to.not.include('replySchemas');
  });

  it('keys replySchemas by controller and handler, and leaves out void, scalar and unschematised replies', () => {
    expect(Object.keys(replies().items).sort()).to.deep.equal(['disc', 'either', 'list', 'needsB', 'oneOf', 'open', 'read', 'tree']);
  });

  it('strips undeclared keys at every depth, where the request schema rejects them', () => {
    const wire = { a: 'x', future: 1, inner: { b: 1, future: 2 }, tags: [{ b: 2, future: 3 }] };
    expect(schema('DtoReply').parse(wire)).to.deep.equal({ a: 'x', inner: { b: 1 }, tags: [{ b: 2 }] });
    expect((module.DtoSchema as { safeParse(v: unknown): { success: boolean } }).safeParse(wire).success).to.equal(false);
    expect(replies().items.read.parse(wire)).to.deep.equal({ a: 'x', inner: { b: 1 }, tags: [{ b: 2 }] });
  });

  it('still checks what the server promises', () => {
    expect(() => schema('DtoReply').parse({ inner: { b: 1 } })).to.throw();
    expect(() => schema('DtoReply').parse({ a: 'x', inner: { b: 'no' } })).to.throw();
  });

  it('parses an array reply through the lenient item schema', () => {
    expect(replies().items.list.parse([{ a: 'x', future: 1 }])).to.deep.equal([{ a: 'x' }]);
  });

  it('keeps an open object open', () => {
    expect(replies().items.open.parse({ id: 1, future: true })).to.deep.equal({ id: 1, future: true });
  });

  it('keeps the undeclared keys of an object whose checks read them', () => {
    expect(replies().items.needsB.parse({ a: 'x', b: 1 })).to.deep.equal({ a: 'x', b: 1 });
    expect(() => replies().items.needsB.parse({ a: 'x' })).to.throw();
  });

  it('reads a recursive reply through the Reply variant', () => {
    expect(replies().items.tree.parse({ name: 'r', future: 1, child: { name: 'c', future: 2 } })).to.deep.equal({ name: 'r', child: { name: 'c' } });
  });

  describe('unions', () => {
    const ajvOneOf = () => module.OneOfSchema as { safeParse(v: unknown): { success: boolean } };

    it('a oneOf counts its matches against the members as the server checks them', () => {
      const value = { f: { b: 2147483648 } };
      expect(ajvOneOf().safeParse(value).success).to.equal(true);
      expect(replies().items.oneOf.parse(value)).to.deep.equal(value);
      expect(replies().items.oneOf.parse({ f: {} })).to.deep.equal({ f: {} });
    });

    it('a oneOf takes a value a newer server extended, and refuses one that is no object', () => {
      expect(() => replies().items.oneOf.parse({ f: { b: 1, future: true } })).to.not.throw();
      expect(() => replies().items.oneOf.parse({ f: 5 })).to.throw();
    });

    it('a oneOf with a shared tag keeps the keys of the open member', () => {
      expect(replies().items.disc.parse({ kind: 'a', toString: 'a' })).to.deep.equal({ kind: 'a', toString: 'a' });
      expect(() => replies().items.disc.parse({ kind: 'c' })).to.throw();
    });

    it('an anyOf of closed objects returns the member a value fits exactly, with all its keys', () => {
      const wire = { id: 1, email: 'a@b', role: 'owner' };
      expect(replies().items.either.parse(wire)).to.deep.equal(wire);
      expect(replies().items.either.parse({ id: 1, email: 'a@b' })).to.deep.equal({ id: 1, email: 'a@b' });
    });

    it('an anyOf strips a value a newer server extended', () => {
      expect(replies().items.either.parse({ id: 1, email: 'a@b', future: true })).to.deep.equal({ id: 1, email: 'a@b' });
      expect(() => replies().items.either.parse({ id: 'x' })).to.throw();
    });
  });

  it('does not repeat a member whose reply print equals its exact print', async () => {
    const scalars = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    const manifest = manifestWith(await appBasicManifest(), {}, { 'test/Scalars': scalars }, [replying('scalars', 'unknown', 'test/Scalars')]);
    const { contents } = emitZod(buildClientModel(manifest), { replies: true });
    expect(contents).to.include('scalars: /*#__PURE__*/ z.union([z.string(), z.number()]),');
  });

  it('reports what it drops from a reply schema that no request schema covers', async () => {
    const inline = { type: 'object', properties: { a: { type: 'string' } }, minProperties: 1 };
    const withInline = manifestWith(await appBasicManifest(), {}, { 'test/Inline': inline }, [replying('inline', 'unknown', 'test/Inline')]);
    const codes = (replies: boolean) => emitZod(buildClientModel(withInline), { replies }).diagnostics.map((d) => [d.code, d.schema, d.pointer]);
    expect(codes(false)).to.deep.equal([]);
    expect(codes(true)).to.deep.equal([['ZOD003', 'test/Inline', '/minProperties']]);
  });

  it('zodReplies parses by route, passes unknown routes through and takes its own schemas', () => {
    const parse = (module.zodReplies as (schemas?: unknown) => (route: { controller: string; name: string }, value: unknown) => unknown)();
    expect(parse({ controller: 'items', name: 'read' }, { a: 'x', future: 1 })).to.deep.equal({ a: 'x' });
    expect(parse({ controller: 'items', name: 'count' }, 5)).to.equal(5);
    expect(parse({ controller: 'constructor', name: 'toString' }, 'v')).to.equal('v');
    expect(() => parse({ controller: 'items', name: 'read' }, { future: 1 })).to.throw();
    const custom = (module.zodReplies as (schemas: unknown) => (route: { controller: string; name: string }, value: unknown) => unknown)({ items: { read: { parse: () => 'custom' } } });
    expect(custom({ controller: 'items', name: 'read' }, {})).to.equal('custom');
  });

  it('matches the committed snapshot', async () => {
    const files = await generateClientFiles({ manifest: await appBasicManifest(), zod: { replies: true } });
    matchesSnapshot('app-basic-replies/client.zod.ts', files[1].contents);
    matchesSnapshot('app-basic-replies/client.ts', files[0].contents);
  });

  for (const mini of [false, true]) {
    it(`type-checks with client.ts and accepts zodReplies() as parseReply (${mini ? 'zod/mini' : 'zod'})`, async () => {
      for (const source of [manifest, await appBasicManifest()]) {
        const [client, zod] = await generateClientFiles({ manifest: source, zod: { replies: true, mini } });
        const use = "import { createAppClient } from './client.js';\nimport { zodReplies, replySchemas } from './client.zod.js';\nexport const api = createAppClient({ baseUrl: 'http://h', parseReply: zodReplies() });\nexport const own = createAppClient({ baseUrl: 'http://h', parseReply: zodReplies(replySchemas) });\n";
        expect(typecheckFiles({ 'client.ts': client.contents, 'client.zod.ts': zod.contents, 'use.ts': use }, { noUnusedLocals: true })).to.deep.equal([]);
      }
    });
  }
});
