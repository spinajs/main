import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { Configuration, MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { hashManifest, type Manifest, type SocketContractEntry, type SocketControllerEntry } from '@spinajs/manifest';
import { WIRE_EVENTS, defineContract } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, Payload, SocketController } from '../src/decorators.js';
import { SocketContractEnforcer } from '../src/contract.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { ContractSocket, OkSocket, seen } from './contract-sockets.js';
import { ITestServer, command, configure, errorOf, manifestFromEnv, open, resultOf, startServer } from './harness.js';

const CONTRACT_ID = 'app:CTR_CONTRACT';
const source = { file: 'src/x.ts', line: 1, col: 1, package: 'app' };
const controllerSource = { ...source, file: 'test/contract-sockets.ts' };
const ref = (schema: string) => ({ text: schema, schema });

const SCHEMAS = {
  'spinajs/app/Inner': { $id: 'spinajs/app/Inner', type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  'spinajs/app/Greet': {
    $id: 'spinajs/app/Greet',
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer' }, email: { type: 'string', format: 'email' }, home: { $ref: 'spinajs/app/Inner' } },
    required: ['name'],
    additionalProperties: false,
    'x-derived': { type: 'object', 'x-nested': { deep: true } },
  },
  'spinajs/app/Greeted': { $id: 'spinajs/app/Greeted', type: 'object', properties: { hello: { type: 'string' } }, required: ['hello'], additionalProperties: false },
  'spinajs/app/Ok': { $id: 'spinajs/app/Ok', type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
  'spinajs/app/Loose': { $id: 'spinajs/app/Loose', type: 'object', properties: { only: { type: 'string' } }, required: ['only'], 'x-explicit': 'partial' },
};

// The kinds of schema a real manifest holds next to the contract schemas: the configuration schemas of its packages.
const UNUSABLE_SCHEMAS: Record<string, object> = {
  'a $data rule': { type: 'object', properties: { burst: { type: 'integer' }, limit: { type: 'integer', minimum: { $data: '1/burst' } } } },
  'a subschema the compiler could not read': { type: 'object', allOf: [null] },
  'a $schema Ajv does not know': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
};

const OK_CONTRACT_ID = 'app:OK_CONTRACT';

function manifestOf(overrides: { controller?: Partial<SocketControllerEntry>; contract?: Partial<SocketContractEntry>; schemas?: Manifest['schemas']; extraContracts?: SocketContractEntry[]; extraControllers?: SocketControllerEntry[] } = {}): Manifest {
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
    source: controllerSource,
    ...overrides.controller,
  };
  const okContract: SocketContractEntry = { id: OK_CONTRACT_ID, commands: { 'ok.say': { payload: ref('spinajs/app/Ok'), result: { text: 'void' } } }, events: {}, clientEvents: {}, source };
  const okController: SocketControllerEntry = {
    id: 'app:OkSocket',
    className: 'OkSocket',
    prefix: 'ok',
    contract: OK_CONTRACT_ID,
    commands: [{ name: 'say', handler: 'say', payload: ref('spinajs/app/Ok'), result: { text: 'void' }, options: {}, policies: [], source }],
    events: [],
    source: controllerSource,
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
    socketControllers: [controller, okController, ...(overrides.extraControllers ?? [])],
    socketContracts: [contract, okContract, ...(overrides.extraContracts ?? [])],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: overrides.schemas ?? SCHEMAS,
    diagnostics: [],
  };
  return { ...manifest, hash: hashManifest(manifest) };
}

const CONTRACT = defineContract<{ commands: Record<string, never>; events: Record<string, never> }>(CONTRACT_ID);
const OK_CONTRACT = defineContract<{ commands: Record<string, never>; events: Record<string, never> }>(OK_CONTRACT_ID);
const ANONYMOUS_CONTRACT = defineContract<{ commands: Record<string, never>; events: Record<string, never> }>();

class MissingSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    return { hello: payload.name };
  }
}
Object.defineProperty(MissingSocket, 'name', { value: 'ContractSocket' });

// same class name and commands as ContractSocket, but another prefix and no contract option
class ImpostorSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    return { hello: payload.name };
  }
}
Object.defineProperty(ImpostorSocket, 'name', { value: 'ContractSocket' });

class BareSocket extends BaseSocketController {
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
Object.defineProperty(BareSocket, 'name', { value: 'ContractSocket' });

class AnonSocket extends BaseSocketController {
  @Command('say')
  public async say(@Payload() payload: { name: string }) {
    return { hello: payload.name };
  }
}
Object.defineProperty(AnonSocket, 'name', { value: 'ContractSocket' });

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
  let restoreEnv: (() => void) | undefined;

  const writeManifest = (manifest: Manifest) => writeFileSync(path, JSON.stringify(manifest));
  const useManifest = (mode: string) => {
    restoreEnv?.();
    restoreEnv = manifestFromEnv(mode, path);
  };

  async function start(mode: string): Promise<ITestServer> {
    useManifest(mode);
    server = await startServer();
    return server;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'socket-contract-'));
    path = join(dir, 'app.manifest.json');
    const declare = (type: typeof BaseSocketController, prefix: string, contract?: typeof CONTRACT) => {
      SocketController(prefix, contract ? { contract } : {})(type);
      DI.unregister(type);
    };
    declare(ContractSocket, 'ctr', CONTRACT);
    declare(MissingSocket, 'ctr', CONTRACT);
    declare(OkSocket, 'ok', OK_CONTRACT);
    declare(ImpostorSocket, 'other', CONTRACT);
    declare(BareSocket, 'ctr');
    declare(AnonSocket, 'ctr', ANONYMOUS_CONTRACT);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    // the configuration source left this suite's manifest in root, where a later app without that source would read it
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  beforeEach(() => {
    seen.length = 0;
    DI.register(ContractSocket).as(BaseSocketController);
  });

  afterEach(async () => {
    DI.unregister(ContractSocket);
    for (const type of [MissingSocket, OkSocket, ImpostorSocket, BareSocket, AnonSocket]) DI.unregister(type);
    await server?.close();
    server = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
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

    for (const [name, schema] of Object.entries(UNUSABLE_SCHEMAS)) {
      for (const mode of ['require', 'prefer']) {
        it(`${mode}: a schema no contract uses, ${name}, changes nothing`, async () => {
          writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Other': schema } }));
          const client = await open(await start(mode));
          expect(resultOf(await command(client, 'ctr.say', { name: 'ada' }))).to.deep.equal({ hello: 'ada' });
          // the schema derived from the handler refuses this as well, with its own message
          expect(errorOf(await command(client, 'ctr.say', { name: 'ada', age: 'old' })).message).to.equal('payload does not match the socket contract');
          client.close();
        });
      }
    }

    describe('x-* names', () => {
      const withToken = (extra: object) => ({ ...SCHEMAS, 'spinajs/app/Greet': { ...SCHEMAS['spinajs/app/Greet'], properties: { name: { type: 'string' }, 'x-token': { type: 'string', maxLength: 2 } }, ...extra } });

      it('keeps the rule of a payload property named x-*, on an open object', async () => {
        writeManifest(manifestOf({ schemas: withToken({ additionalProperties: true }) }));
        const client = await open(await start('require'));
        expect(errorOf(await command(client, 'ctr.say', { name: 'ada', 'x-token': 12345 })).message).to.equal('payload does not match the socket contract');
        expect(resultOf(await command(client, 'ctr.say', { name: 'ada', 'x-token': 'ok' }))).to.deep.equal({ hello: 'ada' });
        client.close();
      });

      it('accepts a payload property named x-* the closed schema declares', async () => {
        writeManifest(manifestOf({ schemas: withToken({ required: ['name', 'x-token'] }) }));
        const client = await open(await start('require'));
        expect(resultOf(await command(client, 'ctr.say', { name: 'ada', 'x-token': 'ok' }))).to.deep.equal({ hello: 'ada' });
        client.close();
      });
    });

    it('accepts an intersection of closed objects, and only what its members declare', async () => {
      const part = (name: string, type: string) => ({ $id: `spinajs/app/${name}`, type: 'object', properties: { [name]: { type } }, required: [name], additionalProperties: false });
      const schemas = {
        ...SCHEMAS,
        'spinajs/app/name': part('name', 'string'),
        'spinajs/app/age': part('age', 'integer'),
        'spinajs/app/Greet': { $id: 'spinajs/app/Greet', allOf: [{ $ref: 'spinajs/app/name' }, { $ref: 'spinajs/app/age' }] },
      };
      writeManifest(manifestOf({ schemas }));
      const client = await open(await start('require'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: 36 }))).to.deep.equal({ hello: 'ada' });
      expect(errorOf(await command(client, 'ctr.say', { name: 'ada', age: 36, extra: 1 })).code).to.equal('invalid_argument');
      expect(errorOf(await command(client, 'ctr.say', { name: 'ada' })).code).to.equal('invalid_argument');
      client.close();
    });

    it('accepts anything where the contract schema references a partial schema, as documentation only', async () => {
      writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Inner': { ...SCHEMAS['spinajs/app/Inner'], 'x-explicit': 'partial' } } }));
      const client = await open(await start('require'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', home: { other: 1 } }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('takes the annotation keywords of the framework and of JSON Schema', async () => {
      const greet = { ...SCHEMAS['spinajs/app/Greet'], $configurationModule: 'greet', title: 'Greet', description: 'd', $comment: 'c', examples: [{}], deprecated: false, readOnly: false, writeOnly: false, default: {} };
      writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Greet': greet } }));
      const client = await open(await start('require'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada' }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('skips a $data rule when the client omits the field it reads, which is why the docs ask for it to be required', async () => {
      const greet = { ...SCHEMAS['spinajs/app/Greet'], properties: { name: { type: 'string' }, floor: { type: 'integer' }, age: { type: 'integer', minimum: { $data: '1/floor' } } } };
      writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Greet': greet } }));
      const client = await open(await start('require'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: -1 }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('enforces a $data rule of the contract schema, and the error names the rule, not the other field of the payload', async () => {
      const greet = { ...SCHEMAS['spinajs/app/Greet'], properties: { name: { type: 'string' }, floor: { type: 'integer' }, age: { type: 'integer', minimum: { $data: '1/floor' } } } };
      writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Greet': greet } }));
      const client = await open(await start('require'));

      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', floor: 18, age: 36 }))).to.deep.equal({ hello: 'ada' });

      const error = errorOf(await command(client, 'ctr.say', { name: 'ada', floor: 987654, age: 36 }));
      expect(error.code).to.equal('invalid_argument');
      expect(JSON.stringify(error)).to.not.contain('987654');
      expect((error.details as { errors: Array<{ message: string }> }).errors[0].message).to.equal('must pass "minimum" against the value at $data "1/floor"');
      client.close();
    });

    it('refuses a missing payload', async () => {
      const client = await open(await start('require'));
      expect(errorOf(await command(client, 'ctr.say')).code).to.equal('invalid_argument');
      client.close();
    });

    it('refuses a payload whose string breaks a format', async () => {
      const client = await open(await start('require'));
      expect(errorOf(await command(client, 'ctr.say', { name: 'ada', email: 'not-an-email' })).code).to.equal('invalid_argument');
      client.close();
    });

    it('bounds the reported errors and says how many there were', async () => {
      const client = await open(await start('require'));
      const payload = { name: 'ada', ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`extra${i}`, i])) };
      const details = errorOf(await command(client, 'ctr.say', payload)).details as { errors: unknown[]; total: number };
      expect(details.errors).to.have.length(10);
      expect(details.total).to.equal(40);
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

    it('a system.manifest merged after the configuration source decided does not turn enforcement on', async () => {
      writeManifest(manifestOf());
      server = await startServer({ system: { manifest: { mode: 'require', path } } });
      const client = await open(server);
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: 'x' }))).to.deep.equal({ hello: 'ada' });
      client.close();
    });

    it('an app built without the configuration source is switched by its system.manifest', async () => {
      writeManifest(manifestOf());
      await configure();
      DI.uncache(MANIFEST.key);
      DI.uncache(MANIFEST_SETTINGS.key);
      DI.get(Configuration)!.set('system.manifest', { mode: 'require', path });
      const enforcer = DI.resolve(SocketContractEnforcer);
      expect(enforcer.mode()).to.equal('require');
      expect(enforcer.manifest()?.socketContracts.map((c) => c.id)).to.include(CONTRACT_ID);
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
    const buildWith = async (mode: string, ...bound: Array<typeof BaseSocketController>) => {
      useManifest(mode);
      await configure();
      if (!bound.includes(ContractSocket)) {
        DI.unregister(ContractSocket);
      }
      for (const type of bound) {
        if (type !== ContractSocket) DI.register(type).as(BaseSocketController);
      }
      return DI.resolve(SocketHandlerRegistry);
    };

    const warningsOf = (): string[] => {
      const warnings: string[] = [];
      const enforcer = DI.resolve(SocketContractEnforcer) as unknown as { Log: { warn(fields: { problem: string }): void } };
      enforcer.Log.warn = (fields) => void warnings.push(fields.problem);
      return warnings;
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
      await expect(registry.build()).to.be.rejectedWith(/ContractSocket \(prefix 'ctr'\) is not in the manifest/);
    });

    it('require: a runtime contract id that differs from the manifest binding fails build()', async () => {
      writeManifest(manifestOf({ controller: { contract: 'app:OTHER' } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/bound to contract app:CTR_CONTRACT at runtime but to app:OTHER/);
    });

    it('require: a schema with an unresolved $ref fails build() naming the contract and the ref, without dumping the schema', async () => {
      const { 'spinajs/app/Inner': _inner, ...withoutInner } = SCHEMAS;
      writeManifest(manifestOf({ schemas: withoutInner }));
      const registry = await buildWith('require', ContractSocket);
      const error = await registry.build().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message).to.match(/ContractSocket/).and.match(/app:CTR_CONTRACT/).and.match(/spinajs\/app\/Inner/);
      expect(error?.message).to.not.match(/properties|additionalProperties|MissingRefError/);
    });

    describe('a rule the contract validator cannot apply', () => {
      const withMember = (member: object) => ({ ...SCHEMAS, 'spinajs/app/Greet': { ...SCHEMAS['spinajs/app/Greet'], properties: { ...SCHEMAS['spinajs/app/Greet'].properties, tags: member } } });
      const cases: Array<[string, object, RegExp]> = [
        ['regexp', { type: 'string', regexp: '/^a/' }, /unknown keyword: "regexp"/],
        ['uniqueItemProperties', { type: 'array', uniqueItemProperties: ['id'] }, /unknown keyword: "uniqueItemProperties"/],
        ['$merge', { $merge: { source: { type: 'string' }, with: {} } }, /unknown keyword: "\$merge"/],
        ['an unknown format', { type: 'string', format: 'no-such-format' }, /unknown format "no-such-format"/],
      ];

      for (const [name, member, expected] of cases) {
        it(`require: ${name} fails build() and names what it cannot apply`, async () => {
          writeManifest(manifestOf({ schemas: withMember(member) }));
          const registry = await buildWith('require', ContractSocket);
          await expect(registry.build()).to.be.rejectedWith(expected);
        });
      }

      it('require: the same, in a schema the contract reaches through a $ref', async () => {
        writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Inner': { ...SCHEMAS['spinajs/app/Inner'], regexp: '/^a/' } } }));
        const registry = await buildWith('require', ContractSocket);
        await expect(registry.build()).to.be.rejectedWith(/app:CTR_CONTRACT cannot be enforced.*unknown keyword: "regexp"/);
      });

      it('prefer: warns and does not claim to enforce it', async () => {
        writeManifest(manifestOf({ schemas: withMember({ type: 'string', regexp: '/^a/' }) }));
        const registry = await buildWith('prefer', ContractSocket);
        const warnings = warningsOf();
        await registry.build();
        expect(warnings.join('\n')).to.match(/app:CTR_CONTRACT cannot be enforced.*unknown keyword: "regexp"/);
      });
    });

    describe('a schema Ajv refuses', () => {
      const REFUSED: Array<[string, object]> = [
        ['with a subschema the compiler could not read', { ...SCHEMAS['spinajs/app/Inner'], allOf: [null] }],
        ['in a $schema Ajv does not know', { ...SCHEMAS['spinajs/app/Inner'], $schema: 'https://json-schema.org/draft/2020-12/schema' }],
      ];

      for (const [name, schema] of REFUSED) {
        it(`require: behind a $ref, ${name}, fails build() and is reported as refused, not as missing`, async () => {
          writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Inner': schema } }));
          const registry = await buildWith('require', ContractSocket);
          await expect(registry.build()).to.be.rejectedWith(/app:CTR_CONTRACT cannot be enforced.*spinajs\/app\/Inner is not a valid JSON Schema/);
        });
      }

      it('prefer: warns, for a schema behind a $ref and for the root', async () => {
        writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Inner': REFUSED[0][1] } }));
        const registry = await buildWith('prefer', ContractSocket);
        const warnings = warningsOf();
        await registry.build();
        expect(warnings.join('\n')).to.match(/spinajs\/app\/Inner is not a valid JSON Schema/);

        writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Greet': REFUSED[0][1] } }));
        const rootRegistry = await buildWith('prefer', ContractSocket);
        const rootWarnings = warningsOf();
        await rootRegistry.build();
        expect(rootWarnings.join('\n')).to.match(/app:CTR_CONTRACT cannot be enforced/);
      });
    });

    it('require: a contract payload schema absent from the manifest fails build()', async () => {
      const commands = { 'ctr.say': { payload: ref('spinajs/app/Ghost'), result: ref('spinajs/app/Greeted') }, 'ctr.loose': { payload: ref('spinajs/app/Loose'), result: { text: 'void' } } };
      writeManifest(manifestOf({ contract: { commands } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/app:CTR_CONTRACT cannot be enforced.*spinajs\/app\/Ghost is not in the manifest/);
    });

    it('require: a contract that needs a schema Ajv refuses fails build()', async () => {
      writeManifest(manifestOf({ schemas: { ...SCHEMAS, 'spinajs/app/Greet': UNUSABLE_SCHEMAS['a subschema the compiler could not read'] } }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/app:CTR_CONTRACT cannot be enforced/);
    });

    it('prefer: a contract whose schema cannot compile is skipped with a warning; the other contracts still enforce', async () => {
      const { 'spinajs/app/Inner': _inner, ...withoutInner } = SCHEMAS;
      writeManifest(manifestOf({ schemas: withoutInner }));
      DI.register(OkSocket).as(BaseSocketController);
      const client = await open(await start('prefer'));
      expect(resultOf(await command(client, 'ctr.say', { name: 'ada', age: 'old' }))).to.deep.equal({ hello: 'ada' });
      expect(errorOf(await command(client, 'ok.say', { n: 'x' })).code).to.equal('invalid_argument');
      client.close();
    });

    it('prefer: the skipped contract is reported as a warning', async () => {
      const { 'spinajs/app/Inner': _inner, ...withoutInner } = SCHEMAS;
      writeManifest(manifestOf({ schemas: withoutInner }));
      const registry = await buildWith('prefer', ContractSocket);
      const warnings = warningsOf();
      await registry.build();
      expect(warnings.join('\n')).to.match(/app:CTR_CONTRACT[\s\S]*spinajs\/app\/Inner/);
    });

    it('require: a same-named controller with another prefix does not adopt the manifest entry', async () => {
      writeManifest(manifestOf());
      const registry = await buildWith('require', ImpostorSocket);
      await expect(registry.build()).to.be.rejectedWith(/ContractSocket \(prefix 'other'\) is not in the manifest/);
    });

    it('require: two manifest entries with the same class name and prefix are ambiguous', async () => {
      writeManifest(manifestOf({ extraControllers: [{ ...manifestOf().socketControllers[0], id: 'other-pkg:ContractSocket' }] }));
      const registry = await buildWith('require', MissingSocket);
      await expect(registry.build()).to.be.rejectedWith(/ambiguous/);
    });

    it('require: a manifest-bound controller whose runtime declaration has no contract is still enforced', async () => {
      writeManifest(manifestOf());
      DI.unregister(ContractSocket);
      DI.register(BareSocket).as(BaseSocketController);
      const client = await open(await start('require'));
      expect(errorOf(await command(client, 'ctr.say', { age: 'old' })).code).to.equal('invalid_argument');
      expect(seen).to.deep.equal([]);
      client.close();
    });

    it('prefer: a manifest-bound controller without a runtime contract is not enforced and the gap is reported', async () => {
      writeManifest(manifestOf());
      const registry = await buildWith('prefer', BareSocket);
      const warnings = warningsOf();
      await registry.build();
      expect(warnings.join('\n')).to.match(/declares no contract/);
      expect(registry.command('ctr.say')?.contractValidator).to.equal(undefined);
    });

    it('require: a runtime contract without an id that the manifest does not bind fails with a fixing hint', async () => {
      writeManifest(manifestOf({ controller: { contract: undefined } }));
      const registry = await buildWith('require', AnonSocket);
      await expect(registry.build()).to.be.rejectedWith(/contract of ContractSocket is not in the manifest: give it an explicit id with defineContract\('<id>'\) or export it from a package with a manifest fragment/);
    });

    it('a duplicate contract id in the manifest fails build() in require', async () => {
      const manifest = manifestOf();
      writeManifest(manifestOf({ extraContracts: [{ ...manifest.socketContracts[0], source: { ...source, line: 9 } }] }));
      const registry = await buildWith('require', ContractSocket);
      await expect(registry.build()).to.be.rejectedWith(/app:CTR_CONTRACT is declared twice .*give one of them a different id/);
    });
  });
});
