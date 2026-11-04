import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest, RouteEntry } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClientFiles } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, route } from '../support/zod.js';

const snapshot = (name: string) => fileURLToPath(new URL(`../__snapshots__/zod/${name}`, import.meta.url));

function matchesSnapshot(name: string, contents: string): void {
  const path = snapshot(name);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(contents).to.equal(readFileSync(path, 'utf8'));
}

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
const list = { type: 'array', items: { $ref: 'test/Dto' } };

async function fixture(): Promise<Manifest> {
  const routes = [
    replying('read', 'Dto', 'test/Dto'),
    replying('list', 'unknown', 'test/List'),
    replying('open', 'Open', 'test/Open'),
    replying('needsB', 'NeedsB', 'test/NeedsB'),
    replying('tree', 'Node', 'test/Node'),
    replying('count', 'number'),
    route('remove', 'delete', []),
  ];
  return manifestWith(await appBasicManifest(), {}, { 'test/Dto': dto, 'test/Inner': inner, 'test/Open': open, 'test/NeedsB': needsB, 'test/Node': node, 'test/List': list }, routes);
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
    expect(Object.keys(replies().items).sort()).to.deep.equal(['list', 'needsB', 'open', 'read', 'tree']);
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
