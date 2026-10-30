import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { hashManifest, type Manifest, type SocketControllerEntry } from '@spinajs/manifest';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { SocketController } from '../src/decorators.js';
import { DerivedSocket, received } from './derived-payload-sockets.js';
import { ITestServer, command, errorOf, manifestFromEnv, open, resultOf, startServer, waitFor } from './harness.js';

const source = { file: 'test/derived-payload-sockets.ts', line: 1, col: 1, package: 'app' };
const ref = (schema: string) => ({ text: schema, schema });

const SCHEMAS = {
  'spinajs/app/Item': { $id: 'spinajs/app/Item', type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } }, required: ['name', 'count'], additionalProperties: false },
  'spinajs/app/LooseItem': { $id: 'spinajs/app/LooseItem', type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } }, required: ['name', 'count'], additionalProperties: false },
};

function manifestOf(schemas: Manifest['schemas'] = SCHEMAS): Manifest {
  const controller: SocketControllerEntry = {
    id: 'app:DerivedSocket',
    className: 'DerivedSocket',
    prefix: 'drv',
    commands: [
      { name: 'create', handler: 'create', payload: ref('spinajs/app/Item'), result: { text: 'unknown' }, options: {}, policies: [], source },
      { name: 'loose', handler: 'loose', payload: ref('spinajs/app/LooseItem'), result: { text: 'unknown' }, options: {}, policies: [], source },
    ],
    events: [{ name: 'note', payload: ref('spinajs/app/Item') }],
    source,
  };
  const manifest: Manifest = {
    manifestVersion: 2,
    app: { name: 'app', version: '0.0.0', root: '.', outDir: 'test' },
    packages: [],
    generatedAt: '2026-10-30T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [controller],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas,
    diagnostics: [],
  };
  return { ...manifest, hash: hashManifest(manifest) };
}

describe('socket payloads validated against manifest-derived schemas', function () {
  this.timeout(20000);

  let dir: string;
  let path: string;
  let server: ITestServer | undefined;
  let restoreEnv: (() => void) | undefined;

  async function start(mode: string, manifest: Manifest = manifestOf()): Promise<ITestServer> {
    writeFileSync(path, JSON.stringify(manifest));
    restoreEnv = manifestFromEnv(mode, path);
    server = await startServer();
    return server;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'socket-derived-'));
    path = join(dir, 'app.manifest.json');
    SocketController('drv')(DerivedSocket);
    DI.unregister(DerivedSocket);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  beforeEach(() => {
    received.length = 0;
    DI.register(DerivedSocket).as(BaseSocketController);
  });

  afterEach(async () => {
    DI.unregister(DerivedSocket);
    await server?.close();
    server = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it('refuses a command payload that breaks the derived schema, without coercion and without echoing it', async () => {
    const client = await open(await start('prefer'));
    expect(resultOf(await command(client, 'drv.create', { name: 'a', count: 1 }))).to.deep.equal({ name: 'a' });

    const error = errorOf(await command(client, 'drv.create', { name: 'a', count: 'hunter2-secret' }));
    expect(error.code).to.equal('invalid_argument');
    expect(JSON.stringify(error)).to.not.include('hunter2-secret');
    expect(errorOf(await command(client, 'drv.create', { name: 'a', count: '2' })).code).to.equal('invalid_argument');
    expect(received).to.deep.equal([{ name: 'a', count: 1 }]);
    client.close();
  });

  it('checks an event payload the same way', async () => {
    const client = await open(await start('prefer'));
    client.emit(WIRE_EVENTS.event, { name: 'drv.note', payload: { name: 'a', count: 'x' } });
    client.emit(WIRE_EVENTS.event, { name: 'drv.note', payload: { name: 'b', count: 2 } });
    await waitFor(() => received.length > 0);
    expect(received).to.deep.equal([{ name: 'b', count: 2 }]);
    client.close();
  });

  it('lets the class @Schema decide over the derived schema', async () => {
    const client = await open(await start('prefer'));
    expect(resultOf(await command(client, 'drv.loose', { name: 'a' }))).to.deep.equal({ name: 'a' });
    client.close();
  });

  it('fails the build in require mode when a derived schema cannot compile', async () => {
    const broken = { ...SCHEMAS, 'spinajs/app/Item': { ...SCHEMAS['spinajs/app/Item'], properties: { name: { $ref: 'spinajs/app/Missing' } } } };
    const error = await start('require', manifestOf(broken)).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).to.match(/drv\.create[\s\S]*unresolved \$ref spinajs\/app\/Missing/);
  });

  it('does not compile the derived schema of a payload with an explicit @Schema', async () => {
    const broken = { ...SCHEMAS, 'spinajs/app/LooseItem': { ...SCHEMAS['spinajs/app/LooseItem'], properties: { name: { $ref: 'spinajs/app/Missing' } } } };
    const client = await open(await start('require', manifestOf(broken)));
    expect(resultOf(await command(client, 'drv.loose', { name: 'a' }))).to.deep.equal({ name: 'a' });
    client.close();
  });

  it('leaves payloads alone in off mode', async () => {
    const client = await open(await start('off'));
    expect(resultOf(await command(client, 'drv.create', { name: 'a', count: 'x' }))).to.deep.equal({ name: 'a' });
    client.close();
  });
});
