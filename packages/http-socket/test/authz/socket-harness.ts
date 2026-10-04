import '@spinajs/log';
import '@spinajs/orm-sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createServer, Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { ResourceAdapter, SYSTEM, UNATTENDED, authz, currentPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
// From the lib, as every other package of the process loads it: a second copy would register a second middleware.
import { AccessResource, Owner } from '@spinajs/authz-orm';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, OrmModelSpec, OrmQuery, SocketHandle, World } from '@spinajs/authz-testing';
import { PROTOCOL_VERSION, SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import type { CommandReply, CommandRequest, SocketError } from '@spinajs/http-socket-common';
import socketConfig from '../../src/config/http-socket.js';
import { BaseSocketController } from '../../src/controller.js';
import { Command, SocketController } from '../../src/decorators.js';
import { ISocketCallStorage, ISocketHandshake, SocketHttpHost, SocketPrincipalSource } from '../../src/interfaces.js';
import { SocketDispatcher } from '../../src/dispatcher.js';
import { SocketHub } from '../../src/hub.js';
import { SocketPrincipalGuard } from '../../src/principal-guard.js';
import { SocketHandlerRegistry } from '../../src/registry.js';
import { SocketServer } from '../../src/server.js';

const fail = (what: string): never => {
  throw new Error(`socketHarness: ${what}`);
};

const PRINCIPAL_KEY = 'behaviourPrincipal';
const principals = new Map<string, Principal>();

/** Yields the principal the client's handshake names: `auth.behaviourPrincipal` is a key into `principals`. */
class BehaviourSocketSource extends SocketPrincipalSource {
  public readonly name = 'behaviour';
  public readonly order = 45;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const key = handshake.auth[PRINCIPAL_KEY];
    return typeof key === 'string' ? principals.get(key) ?? null : null;
  }
}

class BehaviourHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

// The wire carries only a SocketError; the handler's own error is kept here by request id.
const failures = new Map<string, unknown>();

// ---------------------------------------------------------------------------------------------
// World.lane.orm on in-memory SQLite

interface Defined {
  readonly key: string;
  readonly cls: typeof ModelBase & (new () => ModelBase);
  readonly table: string;
}

const pk = (row: ModelBase): string => String((row as unknown as { id: unknown }).id);

/** What this harness maps: `@AccessResource(type, { attributes })` and `@Owner()` over text columns. */
function checkSpec(s: OrmModelSpec): void {
  const where = `model ${s.name}`;
  for (const key of ['relationScope', 'scopeColumns', 'scopes', 'json', 'junctions', 'belongsTo'] as const) if (s[key] !== undefined) fail(`${where}: ${key} is not supported here`);
  const columns = new Set(s.columns);
  if (columns.size !== s.columns.length || columns.has('id')) fail(`${where}: columns repeat a name or list id`);
  if (s.type === undefined && (s.owner !== undefined || s.attributes !== undefined)) fail(`${where}: owner and attributes need a type`);
  if (s.owner !== undefined && !columns.has(s.owner)) fail(`${where}: the owner ${s.owner} is not one of its columns`);
  for (const a of s.attributes ?? []) if (!columns.has(a)) fail(`${where}: the attribute ${a} is not one of its columns`);
  for (const r of s.rows ?? []) {
    if (typeof r.id !== 'string') fail(`${where}: rows need string ids`);
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'id' && !columns.has(k)) fail(`${where}: the row field ${k} is not one of its columns`);
      if (v !== null && typeof v !== 'string') fail(`${where}: ${k} holds a ${typeof v}; only text columns are supported here`);
    }
  }
}

let seq = 0;

/**
 * One class per distinct spec for the whole run, rows reset per case: the authz-orm lib offers no
 * way to forget a registered class, so a class per case would leave stale ones behind.
 */
class SocketOrm {
  private readonly defined = new Map<string, Defined>();
  private current = new Map<string, Defined>();

  constructor(readonly orm: Orm) {}

  private raw(sql: string, params: unknown[] = []): Promise<unknown> {
    const driver = this.orm.Connections.get('sqlite') ?? fail('no sqlite connection');
    return (driver as unknown as { executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, params, QueryContext.Select);
  }

  async use(specs: readonly OrmModelSpec[]): Promise<void> {
    const names = new Set<string>();
    this.current = new Map();
    for (const s of specs) {
      if (names.has(s.name)) fail(`model ${s.name} is declared twice`);
      names.add(s.name);
      checkSpec(s);
      const { rows: _rows, ...shape } = s;
      const key = JSON.stringify(shape);
      const d = this.defined.get(key) ?? (await this.define(s, key));
      await this.raw(`DELETE FROM "${d.table}"`);
      for (const row of s.rows ?? []) {
        const keys = Object.keys(row);
        await this.raw(`INSERT INTO "${d.table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
      }
      this.current.set(s.name, d);
    }
  }

  private async define(s: OrmModelSpec, key: string): Promise<Defined> {
    const name = `${s.name}_${process.pid}_${++seq}`;
    const table = name.toLowerCase();
    const cls = { [name]: class extends ModelBase {} }[name] as typeof ModelBase & (new () => ModelBase);
    Primary()(cls.prototype, 'id');
    if (s.type !== undefined) {
      AccessResource(s.type, s.attributes ? { attributes: [...s.attributes] } : {})(cls);
      if (s.owner !== undefined) Owner()(cls.prototype, s.owner);
    }
    Connection('sqlite')(cls);
    Model(table)(cls);
    await this.raw(`CREATE TABLE "${table}" (${['"id" TEXT PRIMARY KEY', ...s.columns.map((c) => `"${c}" TEXT`)].join(', ')})`);
    const orm = this.orm as unknown as { registerModel(m: unknown): void; applyModelMixins(): void; wireRelations(): void };
    orm.registerModel(cls);
    orm.wireRelations();
    orm.applyModelMixins();
    await this.orm.reloadTableInfo();
    const d = { key, cls, table };
    this.defined.set(key, d);
    return d;
  }

  async run(q: OrmQuery): Promise<{ ids: string[] }> {
    if (q.op !== 'select' || q.clone || q.populate !== undefined) return fail(`only a plain select is supported here, not ${JSON.stringify(q)}`);
    const d = this.current.get(q.model) ?? fail(`no model ${q.model} in the world`);
    let b = (d.cls as unknown as { query(): any }).query();
    for (const [k, v] of Object.entries(q.where ?? {})) b = b.where(k, v);
    return { ids: ((await b) as ModelBase[]).map(pk) };
  }

  async close(): Promise<void> {
    const models = this.orm.Models as { type: unknown }[];
    for (const d of this.defined.values()) {
      await this.raw(`DROP TABLE IF EXISTS "${d.table}"`);
      const i = models.findIndex((m) => m.type === d.cls);
      if (i >= 0) models.splice(i, 1);
      DI.RootContainer.Registry.unregister(d.cls);
    }
    this.defined.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// The harness

/** A server-side command beside the world's handlers; it runs in the call's store, as a handler does. */
export type SocketCommand = (domain: string) => Promise<unknown>;

export interface SocketHarnessOptions {
  /** Events whose handler runs inside `authz(domain).runAs(SYSTEM, 'socket-test', …)`. */
  readonly asSystem?: readonly string[];
  /** Extra commands by name, registered in every case. */
  readonly commands?: Readonly<Record<string, SocketCommand>>;
}

/** What a handler resolves with: the query's ids and the principal the handler ran as (`authz().current()`). */
export interface SocketResult {
  readonly ids: readonly string[];
  readonly principal: { readonly type: string; readonly id: string };
}

function requestId(): string {
  const id = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore()?.requestId;
  return typeof id === 'string' ? id : fail('a handler ran outside its call store');
}

/** The case's commands as one socket controller, under a class name of its own. */
function caseController(caseNo: number, commands: ReadonlyMap<string, () => Promise<unknown>>): Class<BaseSocketController> {
  const Case = class extends BaseSocketController {};
  Object.defineProperty(Case, 'name', { value: `B09SocketCase${caseNo}` });
  let i = 0;
  for (const [name, run] of commands) {
    const key = `command${i++}`;
    (Case.prototype as unknown as Record<string, unknown>)[key] = async function () {
      const id = requestId();
      try {
        return await run();
      } catch (e) {
        failures.set(id, e);
        throw e;
      }
    };
    Reflect.defineMetadata('design:paramtypes', [], Case.prototype, key);
    Command(name)(Case.prototype, key, Object.getOwnPropertyDescriptor(Case.prototype, key)!);
  }
  SocketController()(Case as unknown as Class<BaseSocketController>);
  return Case as unknown as Class<BaseSocketController>;
}

interface Running {
  readonly server: SocketServer;
  readonly host: BehaviourHttpHost;
  readonly url: string;
  readonly path: string;
  readonly orm: SocketOrm;
  readonly undo: (() => void)[];
  readonly restoreConfig: () => void;
}

/**
 * hostHarness plus a real SocketServer on a plain node http server and `World.lane.orm` as
 * `@AccessResource` models on in-memory SQLite. Each `World.lane.socket.handlers` entry becomes a
 * command that runs its ORM query; `emit` opens a socket.io client for the one call. The client
 * sends no credential unless the test side runs as a principal (`as(...)`, a runAs step): then the
 * test SocketPrincipalSource yields that principal for the connection.
 */
export function socketHarness(opts: SocketHarnessOptions = {}): BehaviourHarness {
  const asSystem = new Set(opts.asSystem ?? []);
  let running: Running | undefined;
  let caseNo = 0;
  let registered: Class<BaseSocketController> | undefined;

  const unregisterCase = async () => {
    const c = registered;
    registered = undefined;
    if (!c) return;
    // DI.unregister matches by name; a decorated class can be in the list more than once.
    for (let i = 0; i < 3 && (DI.getRegisteredTypes(BaseSocketController) ?? []).includes(c); i++) DI.unregister(c);
    DI.uncache(c);
    await (DI.get(SocketHandlerRegistry) as SocketHandlerRegistry | undefined)?.build();
  };

  const base = hostHarness({
    facets: ['orm', 'socket'],
    async register(host) {
      const r = running ?? fail('beforeAll did not run');
      const world = host.world;
      for (const key of Object.keys(world.lane ?? {})) if (key !== 'orm' && key !== 'socket') fail(`lane.${key} is another lane's`);
      host.setConfig(['authz', 'orm', 'domain'], host.domain);
      const specs = world.lane?.orm?.models ?? [];
      await r.orm.use(specs);

      // The test domain declares the ORM adapter's permissions of the world's types: root boots once,
      // before the case's classes exist (as authz-orm's own harness does).
      const declared = new Set(world.permissions.map((p) => (typeof p === 'string' ? p : p.name)));
      const types = new Set(specs.flatMap((m) => (m.type === undefined ? [] : [m.type])));
      const adapters = (await DI.resolve(Array.ofType(ResourceAdapter))) as ResourceAdapter[];
      const ormAdapter = adapters.find((a) => (a as unknown as { kind?: string }).kind === 'orm') as unknown as { permissions(): readonly { name: string; types?: readonly string[] }[] } | undefined;
      if (types.size > 0 && !ormAdapter) fail('the authz-orm adapter is not registered');
      for (const { name, ...def } of ormAdapter?.permissions() ?? []) {
        if (!declared.has(name) && def.types?.some((t) => types.has(t))) host.setConfig(['authz', 'domains', host.domain, 'permissions', name], { ...def, types: [...(def.types ?? [])] });
      }

      const domain = host.domain;
      const commands = new Map<string, () => Promise<unknown>>();
      for (const h of world.lane?.socket?.handlers ?? []) {
        if (commands.has(h.event)) fail(`handler ${h.event} is declared twice`);
        commands.set(h.event, async (): Promise<SocketResult> => {
          const query = () => r.orm.run(h.orm);
          const { ids } = asSystem.has(h.event) ? await authz(domain).runAs(SYSTEM, 'socket-test', query) : await query();
          const p = authz(domain).current();
          return { ids, principal: { type: p.type, id: String(p.id) } };
        });
      }
      for (const [name, command] of Object.entries(opts.commands ?? {})) {
        if (commands.has(name)) fail(`command ${name} is also a world handler`);
        commands.set(name, () => command(domain));
      }
      registered = caseController(++caseNo, commands);
      await (DI.get(SocketHandlerRegistry) as SocketHandlerRegistry).build();
    },
    extend() {
      const r = running!;
      const socket: SocketHandle = { emit: (event) => emit(r, event) };
      return { lane: { socket }, dispose: unregisterCase } as Partial<HarnessSession>;
    },
  });

  return {
    ...base,
    async beforeAll() {
      await base.beforeAll?.();
      const cfg = testHost.config();
      const keys = ['logger', 'db', 'http'] as const;
      const before = new Map(keys.map((k) => [k, cfg.get<unknown>(k)]));
      const restoreConfig = () => {
        for (const [k, v] of before) {
          if (v === undefined) cfg.unset(k);
          else cfg.set(k, v);
        }
      };
      cfg.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
      cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] });
      cfg.set('http', { socket: structuredClone({ ...socketConfig.http.socket, transports: ['websocket'] }) });

      const undo = [testHost.registerInRoot(SocketHttpHost, BehaviourHttpHost), testHost.registerInRoot(SocketPrincipalSource, BehaviourSocketSource)];
      const orm = new SocketOrm((await DI.resolve(Orm)) as Orm);
      const host = (await DI.resolve(SocketHttpHost)) as BehaviourHttpHost;
      const server = (await DI.resolve(SocketServer)) as SocketServer;
      await new Promise<void>((resolve) => host.Http.listen(0, '127.0.0.1', () => resolve()));
      const { port } = host.Http.address() as AddressInfo;
      running = { server, host, url: `http://127.0.0.1:${port}`, path: socketConfig.http.socket.path, orm, undo, restoreConfig };
    },
    async afterAll() {
      const r = running;
      running = undefined;
      try {
        if (r) {
          await unregisterCase();
          await r.server.dispose();
          r.host.Http.closeAllConnections();
          await new Promise<void>((resolve) => r.host.Http.close(() => resolve()));
          await r.orm.close();
          await r.orm.orm.dispose();
          // The server's singletons hold the AsyncLocalStorage that uninstalling the host uncaches.
          for (const t of [SocketServer, SocketDispatcher, SocketHub, SocketHandlerRegistry, SocketPrincipalGuard, SocketHttpHost, BehaviourHttpHost, SocketPrincipalSource, BehaviourSocketSource, Orm] as Class<unknown>[]) DI.uncache(t);
          for (const u of r.undo) u();
          r.restoreConfig();
        }
      } finally {
        principals.clear();
        failures.clear();
        await base.afterAll?.();
      }
    },
    async setup(world: World, ctx) {
      try {
        return await base.setup(world, ctx);
      } catch (e) {
        await unregisterCase();
        throw e;
      }
    },
  };
}

/** One call on a fresh connection; the test side's principal, if any, becomes the connection's credential. */
async function emit(r: Running, name: string): Promise<unknown> {
  const ambient = currentPrincipal();
  const auth: Record<string, unknown> = { protocol: PROTOCOL_VERSION, clientId: 'b09-socket' };
  const key = randomUUID();
  if (ambient !== UNATTENDED) {
    principals.set(key, ambient);
    auth[PRINCIPAL_KEY] = key;
  }
  const request: CommandRequest = { id: randomUUID(), name, payload: null };
  const client = io(r.url, { path: r.path, transports: ['websocket'], reconnection: false, forceNew: true, auth });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (err: Error & { data?: SocketError }) => reject(err.data ? wireError(err.data) : err));
    });
    const reply = (await client.timeout(5000).emitWithAck(WIRE_EVENTS.command, request)) as CommandReply;
    if (reply.ok) return 'result' in reply ? reply.result : undefined;
    throw failures.get(request.id) ?? wireError(reply.error);
  } finally {
    client.close();
    principals.delete(key);
    failures.delete(request.id);
  }
}

/** A refusal the server answered before any handler ran ( handshake, a pipeline stage ). */
function wireError(wire: SocketError): SocketException {
  return new SocketException(wire.code, wire.message, { retryable: wire.retryable, ...(wire.details !== undefined ? { details: wire.details } : {}) });
}
