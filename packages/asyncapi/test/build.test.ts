import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import type { Manifest } from '@spinajs/manifest';
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
});
