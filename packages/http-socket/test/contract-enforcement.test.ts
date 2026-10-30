import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { hashManifest, type Manifest, type SocketContractEntry, type SocketControllerEntry } from '@spinajs/manifest';
import { WIRE_EVENTS, defineContract } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, Payload, SocketController } from '../src/decorators.js';
import { SocketContractEnforcer } from '../src/contract.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { ITestServer, command, configure, errorOf, open, resultOf, startServer } from './harness.js';

const CONTRACT_ID = 'app:CTR_CONTRACT';
const source = { file: 'src/x.ts', line: 1, col: 1, package: 'app' };
const ref = (schema: string) => ({ text: schema, schema });

const SCHEMAS = {
  'spinajs/app/Inner': { $id: 'spinajs/app/Inner', type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  'spinajs/app/Greet': {
    $id: 'spinajs/app/Greet',
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer' }, home: { $ref: 'spinajs/app/Inner' } },
    required: ['name'],
    additionalProperties: false,
    'x-derived': { type: 'object', 'x-nested': { deep: true } },
  },
  'spinajs/app/Greeted': { $id: 'spinajs/app/Greeted', type: 'object', properties: { hello: { type: 'string' } }, required: ['hello'], additionalProperties: false },
  'spinajs/app/Loose': { $id: 'spinajs/app/Loose', type: 'object', properties: { only: { type: 'string' } }, required: ['only'], 'x-explicit': 'partial' },
};

function manifestOf(overrides: { controller?: Partial<SocketControllerEntry>; contract?: Partial<SocketContractEntry> } = {}): Manifest {
  const contract: SocketContractEntry = {
    id: CONTRACT_ID,
    commands: { 'ctr.say': { payload: ref('spinajs/app/Greet'), result: ref('spinajs/app/Greeted') }, 'ctr.loose': { payload: ref('spinajs/app/Loose'), result: { text: 'void' } } },
    events: {},
    clientEvents: { 'ctr.ping': ref('spinajs/app/Greet') },
    source,
    ...overrides.contract,
  };
  const controller: SocketControllerEntry = {
    id: 'app:ContractSocket',
    className: 'ContractSocket',
    prefix: 'ctr',
    contract: CONTRACT_ID,
    commands: [
      { name: 'say', handler: 'say', payload: ref('spinajs/app/Greet'), result: ref('spinajs/app/Greeted'), options: {}, policies: [], source },
      { name: 'loose', handler: 'loose', payload: ref('spinajs/app/Loose'), result: { text: 'void' }, options: {}, policies: [], source },
    ],
    events: [{ name: 'ping', payload: ref('spinajs/app/Greet') }],
    source,
    ...overrides.controller,
  };
  const manifest: Manifest = {
    manifestVersion: 2,
    app: { name: 'app', version: '0.0.0', root: '.', outDir: 'lib' },
    packages: [],
    generatedAt: '2026-10-30T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [controller],
    socketContracts: [contract],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: SCHEMAS,
    diagnostics: [],
  };
  return { ...manifest, hash: hashManifest(manifest) };
}

const CONTRACT = defineContract<{ commands: Record<string, never>; events: Record<string, never> }>(CONTRACT_ID);

let seen: Array<{ command: string; payload: unknown }> = [];

class ContractSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    seen.push({ command: 'say', payload });
    return { hello: payload.name };
  }

  @Command('loose')
  public async loose(@Payload() payload: unknown) {
    seen.push({ command: 'loose', payload });
  }

  @OnEvent('ping')
  public async ping(@Payload() payload: unknown) {
    seen.push({ command: 'ping', payload });
  }
}

class MissingSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    return { hello: payload.name };
  }
}
Object.defineProperty(MissingSocket, 'name', { value: 'ContractSocket' });

@SocketController('plain')
class PlainSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }
}
DI.unregister(PlainSocket);

describe('socket contract enforcement', function () {
  this.timeout(20000);

  let dir: string;
  let path: string;
  let server: ITestServer | undefined;

  const writeManifest = (manifest: Manifest) => writeFileSync(path, JSON.stringify(manifest));
  const manifestConfig = (mode: string) => ({ system: { manifest: { mode, path } } });

  async function start(mode: string): Promise<ITestServer> {
    server = await startServer(manifestConfig(mode));
    return server;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'socket-contract-'));
    path = join(dir, 'app.manifest.json');
    for (const type of [ContractSocket, MissingSocket]) {
      SocketController('ctr', { contract: CONTRACT })(type);
      DI.unregister(type);
    }
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    seen = [];
    DI.register(ContractSocket).as(BaseSocketController);
  });

  afterEach(async () => {
    DI.unregister(ContractSocket);
    DI.unregister(MissingSocket);
    await server?.close();
    server = undefined;
  });

  describe('payload validation', () => {
    beforeEach(() => writeManifest(manifestOf()));

    it('passes a payload that matches the contract schema, including a $ref and x-* keys in the manifest', async () => {
      const client = await open(await start('require'));
      const reply = await command(client, 'ctr.say', { name: 'ada', age: 36, home: { city: 'Turin' } });
      expect(resultOf(reply)).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('refuses an invalid payload with invalid_argument before the handler runs', async () => {
      const client = await open(await start('require'));
      const error = errorOf(await command(client, 'ctr.say', { age: 'old', home: {}, extra: 1 }));
      expect(error.code).to.equal('invalid_argument');
      expect(error.retryable).to.equal(false);
      const keywords = (error.details as { errors: Array<{ keyword: string; path: string }> }).errors.map((e) => `${e.keyword}@${e.path}`);
      expect(keywords).to.include.members(['required@', 'type@/age', 'required@/home', 'additionalProperties@']);
      expect(seen).to.deep.equal([]);
      client.close();
    });

    it('does not coerce types', async () => {
      const client = await open(await start('require'));
      expect(errorOf(await command(client, 'ctr.say', { name: 'ada', age: '36' })).code).to.equal('invalid_argument');
      client.close();
    });

    it('refuses a missing payload', async () => {
      const client = await open(await start('require'));
      expect(errorOf(await command(client, 'ctr.say')).code).to.equal('invalid_argument');
      client.close();
    });

    it('validates in prefer mode too', async () => {
      const client = await open(await start('prefer'));
      expect(errorOf(await command(client, 'ctr.say', { age: 1 })).code).to.equal('invalid_argument');
      client.close();
    });

    it('does not treat a partial explicit schema as authoritative', async () => {
      const client = await open(await start('require'));
      await command(client, 'ctr.loose', { anything: true });
      expect(seen).to.deep.equal([{ command: 'loose', payload: { anything: true } }]);
      client.close();
    });

    it('validates client events against the contract', async () => {
      const client = await open(await start('require'));
      client.emit(WIRE_EVENTS.event, { name: 'ctr.ping', payload: { age: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).to.deep.equal([]);
      client.close();
    });
  });

  describe('wire behaviour without enforcement', () => {
    it('mode off leaves payloads alone even with a manifest on disk', async () => {
      writeManifest(manifestOf());
      const client = await open(await start('off'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: 'x' }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('prefer without a manifest file behaves as off', async () => {
      rmSync(path, { force: true });
      const client = await open(await start('prefer'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: 'x' }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('a controller without a contract is never touched', async () => {
      writeManifest(manifestOf());
      DI.register(PlainSocket).as(BaseSocketController);
      try {
        const client = await open(await start('require'));
        expect(resultOf(await command(client, 'plain.echo', 42))).to.equal(42);
        client.close();
      } finally {
        DI.unregister(PlainSocket);
      }
    });
  });

  describe('registry build', () => {
    const buildWith = async (mode: string, bound: typeof MissingSocket) => {
      await configure(manifestConfig(mode));
      if (bound !== ContractSocket) {
        DI.unregister(ContractSocket);
        DI.register(bound).as(BaseSocketController);
      }
      return DI.resolve(SocketHandlerRegistry);
    };

    it('require: a command the contract declares but the controller lacks fails build()', async () => {
      writeManifest(manifestOf());
      const registry = await buildWith('require', MissingSocket);
      await expect(registry.build()).to.be.rejectedWith(/ContractSocket does not satisfy its contract[\s\S]*SOCK001|handler-missing: ContractSocket has no @Command for ctr\.loose/);
    });

    it('prefer: the same gap is logged as a warning and the server starts', async () => {
      writeManifest(manifestOf());
      const registry = await buildWith('prefer', MissingSocket);
      const warnings: string[] = [];
      const enforcer = DI.resolve(SocketContractEnforcer) as unknown as { Log: { warn(fields: { problem: string }): void } };
      enforcer.Log.warn = (fields) => void warnings.push(fields.problem);
      await registry.build();
      expect(warnings.join('\n')).to.match(/handler-missing: ContractSocket has no @Command for ctr\.loose/);
      expect(registry.command('ctr.say')).to.exist;
    });

    it('require: a command the manifest entry lacks fails build() although the controller has it', async () => {
      writeManifest(manifestOf({ controller: { commands: manifestOf().socketControllers[0].commands.slice(0, 1) } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/handler-missing: ContractSocket has no @Command for ctr.loose/);
    });

    it('require: a controller absent from the manifest fails build()', async () => {
      writeManifest(manifestOf({ controller: { className: 'Other' } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/ContractSocket is not in the manifest/);
    });

    it('require: a runtime contract id that differs from the manifest binding fails build()', async () => {
      writeManifest(manifestOf({ controller: { contract: 'app:OTHER' } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/bound to contract app:CTR_CONTRACT at runtime but to app:OTHER/);
    });
  });
});
