import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { hashManifest, type Manifest, type TypeRef } from '@spinajs/manifest';
import { BaseSocketController } from '../src/controller.js';
import { SocketController } from '../src/decorators.js';
import type { ISocketControllerDescriptor } from '../src/interfaces.js';
import { UntypedSocket } from './manifest-runtime-type-sockets.js';
import { SOCKET_CONTROLLER_DESCRIPTOR } from '../src/interfaces.js';
import { ITestServer, command, manifestFromEnv, open, resultOf, startServer } from './harness.js';

const source = { file: 'test/manifest-runtime-type-sockets.ts', line: 1, col: 1, package: 'app' };
const TYPED: TypeRef = { text: 'TypedItem', ref: { package: 'app', file: 'test/manifest-runtime-type-sockets.ts', export: 'TypedItem' } };
const INJECTED = { package: 'app', file: 'test/manifest-runtime-type-sockets.ts', export: 'Injected' };
const DI_ARGS = [{ handler: 'inject', index: 1, ref: INJECTED }];

function manifestOf(payload: TypeRef = TYPED, diArgs = DI_ARGS): Manifest {
  const manifest: Manifest = {
    manifestVersion: 2,
    app: { name: 'app', version: '0.0.0', root: '.', outDir: 'test' },
    packages: [],
    generatedAt: '2026-10-30T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [
      {
        id: 'app:UntypedSocket',
        className: 'UntypedSocket',
        prefix: 'untyped',
        commands: [
          { name: 'create', handler: 'create', payload, result: { text: 'unknown' }, options: {}, policies: [], source },
          { name: 'inject', handler: 'inject', payload, result: { text: 'unknown' }, options: {}, policies: [], source },
        ],
        events: [],
        ...(diArgs.length ? { diArgs } : {}),
        source,
      },
    ],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: {},
    diagnostics: [],
  };
  return { ...manifest, hash: hashManifest(manifest) };
}

describe('socket payload types from the manifest ( no decorator metadata )', function () {
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
    dir = mkdtempSync(join(tmpdir(), 'socket-runtime-type-'));
    path = join(dir, 'app.manifest.json');
    SocketController('untyped')(UntypedSocket);
    DI.unregister(UntypedSocket);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  beforeEach(() => {
    DI.register(UntypedSocket).as(BaseSocketController);
  });

  afterEach(async () => {
    DI.unregister(UntypedSocket);
    await server?.close();
    server = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it('leaves the payload a plain object in off mode: a build without metadata needs the manifest', async () => {
    const client = await open(await start('off'));
    expect(resultOf(await command(client, 'untyped.create', { name: 'a' }))).to.deep.equal({ type: 'Object', name: 'a' });
    client.close();
  });

  it('fails the build in require mode when the manifest cannot type the payload', async () => {
    const error = await start('require', manifestOf({ text: 'TypedItem' })).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).to.match(/the @Payload of UntypedSocket::create has no runtime type/);
  });

  it('hydrates the payload into the class TypeRef.ref names', async () => {
    const client = await open(await start('prefer'));
    expect(resultOf(await command(client, 'untyped.create', { name: 'a' }))).to.deep.equal({ type: 'TypedItem', name: 'a' });
    client.close();
  });

  it('injects a @FromDI() argument of the type the manifest records', async () => {
    const client = await open(await start('require'));
    expect(resultOf(await command(client, 'untyped.inject', { name: 'a' }))).to.deep.equal({ kind: 'injected' });
    client.close();
  });

  it('fails the build in require mode when the manifest cannot type a @FromDI() argument', async () => {
    const error = await start('require', manifestOf(TYPED, [])).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).to.match(/the @FromDI\(\) argument #1 of UntypedSocket::inject has no runtime type/);
  });

  it('keeps what a boot filled out of the class descriptor', async () => {
    await start('prefer');
    const descriptor = Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, UntypedSocket.prototype) as ISocketControllerDescriptor;
    expect([...descriptor.Handlers.values()].flatMap((h) => [...h.Parameters.values()]).map((p) => p.RuntimeType)).to.deep.equal([undefined, undefined, undefined]);
  });

  it('answers from the manifest of this boot, whatever booted before it', async () => {
    const typed = await open(await start('prefer'));
    expect(resultOf(await command(typed, 'untyped.create', { name: 'a' }))).to.deep.equal({ type: 'TypedItem', name: 'a' });
    typed.close();
    await server?.close();
    restoreEnv?.();

    const plain = await open(await start('off'));
    expect(resultOf(await command(plain, 'untyped.create', { name: 'a' }))).to.deep.equal({ type: 'Object', name: 'a' });
    plain.close();
  });
});
