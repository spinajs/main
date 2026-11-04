import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { Manifest, SocketControllerEntry } from '@spinajs/manifest';
import { manifestToAsyncApi } from '../src/index.js';
import type { AsyncApiDocument } from '../src/index.js';
import { appBasicManifest } from './support/fixture.js';

const snapshotPath = fileURLToPath(new URL('./__snapshots__/app-basic.asyncapi.json', import.meta.url));
const options = { title: 'app-basic', version: '1.0.0', serverUrl: 'ws://localhost:4557' };

describe('manifestToAsyncApi', () => {
  let manifest: Manifest;
  let doc: AsyncApiDocument;

  before(async () => {
    manifest = await appBasicManifest();
    doc = manifestToAsyncApi(manifest, options);
  });

  it('matches the committed snapshot', () => {
    const rendered = JSON.stringify(doc, null, 2);
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, rendered);
    expect(rendered).to.equal(readFileSync(snapshotPath, 'utf8'));
  });

  it('drops x-spinajs-type: the document equals the one built without it', () => {
    const mark = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(mark);
      if (typeof node !== 'object' || node === null) return node;
      const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, mark(child)]));
      return copy.type === 'string' ? { ...copy, 'x-spinajs-type': 'Decimal' } : copy;
    };
    const typed = { ...manifest, schemas: mark(manifest.schemas) as Manifest['schemas'] };
    expect(JSON.stringify(typed.schemas)).to.include('"x-spinajs-type":"Decimal"');
    expect(JSON.stringify(manifestToAsyncApi(typed, options))).to.equal(JSON.stringify(doc));
  });

  it('is valid AsyncAPI 3.0', async () => {
    const { document, diagnostics } = await new Parser().parse(JSON.stringify(doc));
    expect(diagnostics.filter((d) => Number(d.severity) === Number(DiagnosticSeverity.Error))).to.deep.equal([]);

    const resolved = document!.allOperations().all().map((op) => op.messages().all().length);
    expect(resolved).to.deep.equal([1, 1, 1, 1, 1, 1, 1]);
  });

  it('names socket and queue channels and marks idempotent commands', () => {
    expect(Object.keys(doc.channels)).to.deep.equal(['queue/SendMailJob', 'queue/UserCreated', 'socket/chat/events/message', 'socket/chat/history', 'socket/chat/send']);
    expect(doc.operations['chat.send.send']['x-idempotent']).to.equal(true);
    expect(doc.operations['chat.history.receive']['x-spinajs-stream']).to.equal(true);
    expect(doc.channels['queue/SendMailJob']['x-spinajs-routing']).to.equal('queue.routing.SendMailJob');
  });

  it('uses the stream flag for stream replies', () => {
    expect(doc.operations['chat.history.receive']['x-spinajs-stream-frames']).to.deep.equal(['chunk', 'end', 'fail']);
    expect(doc.operations['chat.send.receive']['x-spinajs-stream']).to.equal(undefined);
    expect(doc.components.messages['chat.history.reply']).to.deep.equal({ name: 'chat.history.reply', payload: { $ref: '#/components/schemas/ChatMessage' } });
  });

  it('embeds schemas without $id and x-* keys', () => {
    const copy = structuredClone(manifest);
    copy.schemas['spinajs/app-basic/ChatMessage'] = { ...(copy.schemas['spinajs/app-basic/ChatMessage'] as object), 'x-derived': true, properties: { 'x-keep': { type: 'string' } } };
    const schema = manifestToAsyncApi(copy, options).components.schemas['ChatMessage'];
    expect(schema).to.not.have.property('$id');
    expect(schema).to.not.have.property('x-derived');
    expect(schema).to.have.nested.property('properties.x-keep');
  });

  it('carries command timeout, ordering and access extensions', () => {
    const copy = structuredClone(manifest);
    const send = copy.socketControllers[0].commands.find((c) => c.name === 'send')!;
    send.options = { ordered: 'client', timeoutMs: 500 };
    send.access = ['chat:send'];
    const op = manifestToAsyncApi(copy, options).operations['chat.send.send'];
    expect(op).to.include({ 'x-ordered': 'client', 'x-timeout-ms': 500 });
    expect(op['x-authz-permission']).to.deep.equal(['chat:send']);
  });

  it('adds an error reply message when errorSchemaId is in the manifest', () => {
    const out = manifestToAsyncApi(manifest, { ...options, errorSchemaId: 'spinajs/app-basic/ValidationProblem' });
    expect(out.components.messages['chat.send.error']).to.exist;
    expect(out.components.schemas['ValidationProblem']).to.exist;
  });

  it('is byte-stable across runs', () => {
    expect(JSON.stringify(manifestToAsyncApi(manifest, options))).to.equal(JSON.stringify(doc));
  });

  it('documents a command a socket controller inherits, with the payload it binds', () => {
    const copy = structuredClone(manifest);
    const source = { file: 'src/socket/things.ts', line: 3, col: 1, package: 'app-basic' };
    const things: SocketControllerEntry = {
      id: 'app-basic:ThingsSocket',
      className: 'ThingsSocket',
      prefix: 'things',
      bases: ['app-basic:CrudSocket'],
      commands: [{ name: 'save', handler: 'save', payload: { text: 'ChatMessage', schema: 'spinajs/app-basic/ChatMessage' }, payloadIndex: 0, result: { text: 'void' }, options: {}, policies: [], inheritedFrom: 'app-basic:CrudSocket', source }],
      events: [],
      source,
    };
    copy.socketControllers.push(things);
    const out = manifestToAsyncApi(copy, options);
    expect(out.channels['socket/things/save']).to.deep.include({ address: 'socket/things/save' });
    expect(out.components.messages['things.save.request']).to.deep.equal({ name: 'things.save.request', payload: { $ref: '#/components/schemas/ChatMessage' } });
  });

  it('stream frames match the socket wire protocol', () => {
    expect(doc.operations['chat.history.receive']['x-spinajs-stream-frames']).to.deep.equal([WIRE_EVENTS.chunk, WIRE_EVENTS.end, WIRE_EVENTS.fail]);
  });
});
