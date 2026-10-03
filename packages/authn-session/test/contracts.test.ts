import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DateTime } from 'luxon';
import { AsyncService, DI_DESCRIPTION_SYMBOL } from '@spinajs/di';
import type { IInjectDescriptor, IContainer } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { SessionExpirationProvider, SessionProvider } from '../src/contracts.js';
import type { ISession } from '../src/contracts.js';
import * as contracts from '../src/contracts.js';
import * as index from '../src/index.js';

const expect = chai.expect;

// Strict identity: readonly, optionality and union members must all match.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FILE = join(PKG_ROOT, 'src', 'contracts.ts');
const KEY = 'authn.session.expiration';

const alice: IdentityRef = { type: 'user', id: 'alice' };
const bob: IdentityRef = { type: 'user', id: 'bob' };

class FixedExpiration extends SessionExpirationProvider {
  initial(s: ISession): DateTime | undefined {
    return s.Creation.plus({ minutes: 30 });
  }
  renew(_s: ISession): DateTime | undefined {
    return DateTime.now().plus({ minutes: 30 });
  }
}

const sameSubject = (a: IdentityRef | undefined, b: IdentityRef) => !!a && a.type === b.type && a.id === b.id;

// Enough of a store to show the 3.0 members can be implemented as documented.
class MemoryStore extends SessionProvider {
  private rows = new Map<string, ISession>();
  constructor() {
    super();
    this.Expiration = new FixedExpiration();
  }
  async restore(sessionId: string): Promise<ISession | null> {
    const s = this.rows.get(sessionId);
    return s && !this.isExpired(s) ? s : null;
  }
  async save(session: ISession): Promise<void> {
    if (session.Expiration === undefined) this.applyInitialExpiration(session);
    this.rows.set(session.SessionId, session);
  }
  async touch(session: ISession): Promise<boolean> {
    const before = session.Expiration?.toMillis();
    this.applyRenewedExpiration(session);
    return before !== session.Expiration?.toMillis();
  }
  async delete(sessionId: string): Promise<void> {
    this.rows.delete(sessionId);
  }
  async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    let n = 0;
    for (const s of [...this.rows.values()]) {
      if (s.SessionId === opts?.except) continue;
      if (sameSubject(s.Subject, subject) || (opts?.includeImpersonations && sameSubject(s.Impersonator, subject))) {
        this.rows.delete(s.SessionId);
        n++;
      }
    }
    return n;
  }
  async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    return [...this.rows.values()].filter((s) => !this.isExpired(s) && (sameSubject(s.Subject, subject) || (!!opts?.includeImpersonations && sameSubject(s.Impersonator, subject))));
  }
  async truncate(): Promise<void> {
    this.rows.clear();
  }
  initial(s: ISession): void {
    this.applyInitialExpiration(s);
  }
  renewed(s: ISession): void {
    this.applyRenewedExpiration(s);
  }
  expired(s: ISession): boolean {
    return this.isExpired(s);
  }
}

const session = (id: string, over: Partial<ISession> = {}): ISession => ({ SessionId: id, Subject: alice, State: 'active', Creation: DateTime.now(), Data: new Map(), ...over });

interface MemberShape {
  name: string;
  modifiers: string[];
  params: string[] | null;
  decorators: string[];
}

function sourceFile() {
  return ts.createSourceFile(SRC_FILE, readFileSync(SRC_FILE, 'utf8'), ts.ScriptTarget.Latest, true);
}

function classMembers(): Record<string, { base: string | null; typeParams: string[]; members: MemberShape[] }> {
  const sf = sourceFile();
  const out: Record<string, { base: string | null; typeParams: string[]; members: MemberShape[] }> = {};
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || !n.name) return;
    const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    out[n.name.text] = {
      base: heritage ? heritage.types[0].expression.getText(sf) : null,
      typeParams: (n.typeParameters ?? []).map((t) => t.getText(sf)),
      members: n.members.map((m) => ({
        name: m.name ? m.name.getText(sf) : '',
        modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
        params: ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        decorators: (ts.canHaveDecorators(m) ? ts.getDecorators(m) ?? [] : []).map((d) => d.getText(sf)),
      })),
    };
  });
  return out;
}

function docOf(cls: string, member: string): string {
  const sf = sourceFile();
  let doc = '';
  sf.forEachChild((n) => {
    if (!ts.isClassDeclaration(n) || n.name?.text !== cls) return;
    const m = n.members.find((x) => x.name?.getText(sf) === member);
    if (m)
      doc = ts
        .getJSDocCommentsAndTags(m)
        .map((d) => d.getText(sf))
        .join(' ');
  });
  return doc;
}

function interfaceDocs(name: string): Record<string, string> {
  const sf = sourceFile();
  const out: Record<string, string> = {};
  sf.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== name) return;
    for (const m of n.members)
      out[m.name!.getText(sf)] = ts
        .getJSDocCommentsAndTags(m)
        .map((d) => d.getText(sf))
        .join(' ');
  });
  return out;
}

const SNAPSHOT = `(di) => {
  const root = di.DI.RootContainer;
  const registry = root.Registry.registry;
  const cache = root.Cache.cache;
  if (!(registry instanceof Map) || !(cache instanceof Map)) throw new Error('DI internals changed: registry or cache is not a Map');
  const name = (x) => (typeof x === 'function' ? x.name : x && x.constructor ? x.constructor.name : typeof x);
  return {
    registry: [...registry].map(([k, v]) => [k, v.map(name)]),
    cache: [...cache].map(([k, v]) => [k, v.map(name)]),
    events: root.eventNames().map(String),
  };
}`;

const EXERCISE = `(di, m) => {
  const meta = (c) => {
    const d = Reflect.getOwnMetadata(di.DI_DESCRIPTION_SYMBOL, c);
    return d ? d.inject.map((i) => ({ autoinject: i.autoinject, key: String(i.autoinjectKey), inject: i.inject && i.inject.name, data: i.data })) : null;
  };
  return {
    keys: Object.keys(m).sort(),
    provider: meta(m.SessionProvider),
    expiration: meta(m.SessionExpirationProvider),
    asyncService: Object.getPrototypeOf(m.SessionProvider) === di.AsyncService,
  };
}`;

interface Probe {
  before: unknown;
  after: unknown;
  exercise: { keys: string[]; provider: unknown; expiration: unknown; asyncService: boolean };
}

function probe(inputType: 'module' | 'commonjs', body: string): Probe {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`child node (${inputType}) exited with ${r.status}:\n${r.stderr}`);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]) as Probe;
}

const EXPECTED_META = [{ autoinject: true, key: 'Expiration', inject: 'SessionExpirationProvider', data: KEY }];

/** The package's public runtime surface; contracts plus the session building blocks. */
const PUBLIC_EXPORTS = [
  'AbsoluteExpiration',
  'DefaultSessionIssuer',
  'LEGACY_IDENTITY_KEYS',
  'MemorySessionStore',
  'SESSION_COOKIE_BASE_NAME',
  'SESSION_IP_KEY',
  'SESSION_PENDING_STEPS_KEY',
  'SESSION_USER_AGENT_KEY',
  'SessionExpirationProvider',
  'SessionProvider',
  'SlidingCappedExpiration',
  'SlidingExpiration',
  'UserSession',
  'adaptLegacySession',
  'clearSessionCookie',
  'cookieMaxAge',
  'decodeSessionData',
  'encodeSessionData',
  'isLegacySessionId',
  'sessionCookie',
  'sessionCookieMaxAge',
  'sessionCookieName',
  'sessionCookieOptions',
  'sessionHandleOf',
  'storageKeyOf',
];

/** What loading the package may add to the root registry: the issuer, the store and the strategies under their types. */
const EXPECTED_REGISTRATIONS: Record<string, string[]> = {
  SessionProvider: ['MemorySessionStore'],
  SessionIssuer: ['DefaultSessionIssuer'],
  DefaultSessionIssuer: ['DefaultSessionIssuer'],
  MemorySessionStore: ['MemorySessionStore'],
  SessionExpirationProvider: ['AbsoluteExpiration', 'SlidingExpiration', 'SlidingCappedExpiration'],
  AbsoluteExpiration: ['AbsoluteExpiration'],
  SlidingExpiration: ['SlidingExpiration'],
  SlidingCappedExpiration: ['SlidingCappedExpiration'],
};

type Entries = [string, string[]][];
type Snapshot = { registry: Entries; cache: Entries; events: string[] };

/** Entries the import added: new keys, or the values appended to an existing key. */
function delta(before: Entries, after: Entries): Record<string, string[]> {
  const was = new Map(before);
  const out: Record<string, string[]> = {};
  for (const [k, v] of after) {
    const prev = was.get(k) ?? [];
    if (JSON.stringify(prev) !== JSON.stringify(v)) out[k] = v.slice(prev.length);
  }
  return out;
}

describe('@spinajs/authn-session contracts', function () {
  this.timeout(60000);

  describe('runtime', () => {
    it('contracts.ts exports the two classes and the package index re-exports them', () => {
      expect(Object.keys(contracts).sort()).to.deep.eq(['SessionExpirationProvider', 'SessionProvider']);
      expect(index.SessionProvider).to.eq(SessionProvider);
      expect(index.SessionExpirationProvider).to.eq(SessionExpirationProvider);
      expect(Object.keys(index).sort()).to.deep.eq(PUBLIC_EXPORTS);
      expect(Object.getPrototypeOf(SessionProvider)).to.eq(AsyncService);
      expect(Object.getPrototypeOf(SessionExpirationProvider)).to.eq(Function.prototype);
    });

    it('a store can implement the 3.0 members', async () => {
      const store = new MemoryStore();
      await store.save(session('h1'));
      await store.save(session('h2'));
      await store.save(session('h3', { Subject: bob, Impersonator: alice }));
      await store.save(session('h4', { Subject: bob }));
      expect((await store.listBySubject(alice)).map((s) => s.SessionId)).to.deep.eq(['h1', 'h2']);
      expect((await store.listBySubject(alice, { includeImpersonations: true })).map((s) => s.SessionId)).to.deep.eq(['h1', 'h2', 'h3']);
      expect(await store.deleteBySubject(alice, { except: 'h1' })).to.eq(1);
      expect(await store.restore('h3')).to.not.eq(null);
      expect(await store.deleteBySubject(alice, { except: 'h1', includeImpersonations: true })).to.eq(1);
      expect(await store.restore('h3')).to.eq(null);
      expect(await store.restore('h1')).to.not.eq(null);
      expect(await store.restore('h4')).to.not.eq(null);
      await store.truncate();
      expect(await store.restore('h1')).to.eq(null);
    });
  });

  describe('expiration helpers', () => {
    it('an active session gets its initial and renewed expiration from the strategy', () => {
      const store = new MemoryStore();
      const s = session('h1', { Creation: DateTime.fromMillis(0) });
      store.initial(s);
      expect(s.Expiration!.toMillis()).to.eq(30 * 60 * 1000);
      store.renewed(s);
      expect(s.Expiration!.toMillis()).to.be.greaterThan(Date.now());
    });

    it('a pending session is never extended (A09)', async () => {
      const store = new MemoryStore();
      const until = DateTime.now().plus({ seconds: 300 });
      const s = session('p1', { State: 'pending', Expiration: until });
      store.renewed(s);
      expect(s.Expiration).to.eq(until);
      await store.save(s);
      expect(await store.touch(s)).to.eq(false);
      expect(s.Expiration).to.eq(until);
    });

    it('a pending session without its own expiration is refused, not given the active TTL', async () => {
      const store = new MemoryStore();
      expect(() => store.initial(session('p1', { State: 'pending' }))).to.throw(/pendingTtlSeconds/);
      let err: unknown;
      await store.save(session('p2', { State: 'pending' })).catch((e) => (err = e));
      expect(err).to.be.instanceOf(Error);
      expect(await store.restore('p2')).to.eq(null);
    });

    it('an expired row counts as absent; no expiration never expires', async () => {
      const store = new MemoryStore();
      expect(store.expired(session('a', { Expiration: DateTime.now().minus({ seconds: 1 }) }))).to.eq(true);
      expect(store.expired(session('b', { Expiration: DateTime.now().plus({ minutes: 1 }) }))).to.eq(false);
      expect(store.expired(session('c'))).to.eq(false);
      await store.save(session('d', { Expiration: DateTime.now().minus({ seconds: 1 }) }));
      expect(await store.restore('d')).to.eq(null);
    });
  });

  describe('source shape', () => {
    it('holds SessionExpirationProvider and SessionProvider with the 3.0 members', () => {
      const c = classMembers();
      expect(Object.keys(c)).to.deep.eq(['SessionExpirationProvider', 'SessionProvider']);
      expect(c.SessionExpirationProvider.base).to.eq(null);
      expect(c.SessionExpirationProvider.typeParams).to.deep.eq([]);
      expect(c.SessionExpirationProvider.members).to.deep.eq([
        { name: 'initial', modifiers: ['public', 'abstract'], params: ['session'], decorators: [] },
        { name: 'renew', modifiers: ['public', 'abstract'], params: ['session'], decorators: [] },
      ]);
      expect(c.SessionProvider.base).to.eq('AsyncService');
      expect(c.SessionProvider.typeParams).to.deep.eq(['T extends ISession = ISession']);
      expect(c.SessionProvider.members).to.deep.eq([
        { name: 'Expiration', modifiers: ['protected'], params: null, decorators: [`@AutoinjectService('${KEY}', SessionExpirationProvider)`] },
        { name: 'restore', modifiers: ['public', 'abstract'], params: ['sessionId'], decorators: [] },
        { name: 'save', modifiers: ['public', 'abstract'], params: ['session'], decorators: [] },
        { name: 'touch', modifiers: ['public', 'abstract'], params: ['session'], decorators: [] },
        { name: 'delete', modifiers: ['public', 'abstract'], params: ['sessionId'], decorators: [] },
        { name: 'deleteBySubject', modifiers: ['public', 'abstract'], params: ['subject', 'opts'], decorators: [] },
        { name: 'listBySubject', modifiers: ['public', 'abstract'], params: ['subject', 'opts'], decorators: [] },
        { name: 'truncate', modifiers: ['public', 'abstract'], params: [], decorators: [] },
        { name: 'applyInitialExpiration', modifiers: ['protected'], params: ['s'], decorators: [] },
        { name: 'applyRenewedExpiration', modifiers: ['protected'], params: ['s'], decorators: [] },
        { name: 'isExpired', modifiers: ['protected'], params: ['s'], decorators: [] },
      ]);
    });

    it('reads the 3.0 config key only', () => {
      const text = readFileSync(SRC_FILE, 'utf8');
      expect(text).to.contain(`'${KEY}'`);
      expect(text).to.not.contain('rbac.');
    });

    it('imports only what the package may depend on', () => {
      const specs = ts.preProcessFile(readFileSync(SRC_FILE, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
      expect([...specs].sort()).to.deep.eq(['@spinajs/authn/contracts', '@spinajs/configuration', '@spinajs/di', 'luxon']);
    });

    it('docs carry the rules a reader needs', () => {
      const i = interfaceDocs('ISession');
      expect(i.SessionId).to.contain('sha256');
      expect(i.SessionId).to.contain('2.x');
      expect(i.Subject).to.contain('impersonat');
      expect(i.Impersonator).to.contain('SR-06');
      expect(i.State).to.contain('pendingTtlSeconds');
      expect(docOf('SessionProvider', 'restore')).to.contain('absent');
      expect(docOf('SessionProvider', 'restore')).to.contain('2.x');
      expect(docOf('SessionProvider', 'save')).to.contain('verbatim');
      expect(docOf('SessionProvider', 'touch')).to.contain('pending');
      expect(docOf('SessionProvider', 'deleteBySubject')).to.contain('impersonator');
      expect(docOf('SessionProvider', 'deleteBySubject')).to.contain('2.x');
      expect(docOf('SessionProvider', 'deleteBySubject')).to.contain('storage key');
      expect(docOf('SessionProvider', 'deleteBySubject')).to.contain("with includeImpersonations its 'Impersonator'");
      expect(docOf('SessionProvider', 'listBySubject')).to.contain('expired');
    });
  });

  describe('types', () => {
    it('ISession is the 3.0 shape', () => {
      type State = 'pending' | 'active';
      same<ISession, { SessionId: string; Subject: IdentityRef; Impersonator?: IdentityRef; State: State; Creation: DateTime; Expiration?: DateTime; Data: Map<string, unknown> }>(true);
      // @ts-expect-error Subject is required
      const noSubject: ISession = { SessionId: 'h', State: 'active', Creation: DateTime.now(), Data: new Map() };
      // @ts-expect-error State is only pending or active
      const revoked: ISession = { SessionId: 'h', Subject: alice, State: 'revoked', Creation: DateTime.now(), Data: new Map() };
      // @ts-expect-error the 2.x numeric owner is gone
      const legacy: ISession = { SessionId: 'h', Subject: alice, State: 'active', Creation: DateTime.now(), Data: new Map(), UserId: 1 };
      expect([noSubject, revoked, legacy]).to.have.length(3);
    });

    it('SessionProvider members have the 3.0 types', () => {
      same<Parameters<SessionProvider['restore']>, [string]>(true);
      same<ReturnType<SessionProvider['restore']>, Promise<ISession | null>>(true);
      same<Parameters<SessionProvider['save']>, [ISession]>(true);
      same<ReturnType<SessionProvider['save']>, Promise<void>>(true);
      same<Parameters<SessionProvider['touch']>, [ISession]>(true);
      same<ReturnType<SessionProvider['touch']>, Promise<boolean>>(true);
      same<Parameters<SessionProvider['delete']>, [string]>(true);
      same<ReturnType<SessionProvider['delete']>, Promise<void>>(true);
      same<Parameters<SessionProvider['deleteBySubject']>, [IdentityRef, { includeImpersonations?: boolean; except?: string }?]>(true);
      same<ReturnType<SessionProvider['deleteBySubject']>, Promise<number>>(true);
      same<Parameters<SessionProvider['listBySubject']>, [IdentityRef, { includeImpersonations?: boolean }?]>(true);
      same<ReturnType<SessionProvider['listBySubject']>, Promise<ISession[]>>(true);
      same<Parameters<SessionProvider['truncate']>, []>(true);
      same<ReturnType<SessionProvider['truncate']>, Promise<void>>(true);
      same<Parameters<SessionExpirationProvider['initial']>, [ISession]>(true);
      same<ReturnType<SessionExpirationProvider['initial']>, DateTime | undefined>(true);
      same<Parameters<SessionExpirationProvider['renew']>, [ISession]>(true);
      same<ReturnType<SessionExpirationProvider['renew']>, DateTime | undefined>(true);
    });

    it('the row type parameter flows into restore and listBySubject', () => {
      interface Tagged extends ISession {
        Tag: string;
      }
      same<ReturnType<SessionProvider<Tagged>['restore']>, Promise<Tagged | null>>(true);
      same<ReturnType<SessionProvider<Tagged>['listBySubject']>, Promise<Tagged[]>>(true);
    });

    it('the 2.x numeric-owner members are gone', () => {
      const p: SessionProvider = new MemoryStore();
      // @ts-expect-error deleteByUser is replaced by deleteBySubject
      const a = () => p.deleteByUser(1);
      // @ts-expect-error listByUser is replaced by listBySubject
      const b = () => p.listByUser(1);
      expect([a, b]).to.have.length(2);
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new SessionExpirationProvider();
      class VoidDelete extends SessionProvider {
        async restore(): Promise<ISession | null> {
          return null;
        }
        async save(): Promise<void> {}
        async touch(): Promise<boolean> {
          return false;
        }
        async delete(): Promise<void> {}
        // @ts-expect-error deleteBySubject resolves to the count
        async deleteBySubject(): Promise<void> {}
        async listBySubject(): Promise<ISession[]> {
          return [];
        }
        async truncate(): Promise<void> {}
      }
      const p = new MemoryStore();
      // @ts-expect-error except is a storage key, not a handle
      const b = () => p.deleteBySubject(alice, { except: { id: 'raw', state: 'active' } });
      expect([a, b, VoidDelete]).to.have.length(3);
    });
  });

  describe('DI', () => {
    it('@AutoinjectService only records metadata for authn.session.expiration', () => {
      const meta = Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, SessionProvider) as IInjectDescriptor<unknown>;
      expect(meta.inject.map((i) => ({ autoinject: i.autoinject, key: String(i.autoinjectKey), inject: (i.inject as { name: string }).name, data: i.data }))).to.deep.eq(EXPECTED_META);
      expect(meta.inject[0].inject).to.eq(SessionExpirationProvider);
      expect(Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, SessionExpirationProvider)).to.eq(undefined);
    });

    it('the configured service name is read from authn.session.expiration', () => {
      const meta = Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, SessionProvider) as IInjectDescriptor<unknown>;
      const cfg = { [KEY]: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 } } as Record<string, unknown>;
      const container = { get: () => ({ get: (path: string) => cfg[path] }) } as unknown as IContainer;
      expect(meta.inject[0].serviceFunc!(KEY, container)).to.deep.eq({ service: 'SlidingCappedExpiration', options: cfg[KEY] });
    });

    describe('loading the built package registers only the issuer, the memory store and the expiration strategies', () => {
      let esm: Probe;
      let cjs: Probe;

      before(() => {
        for (const f of [join(PKG_ROOT, 'lib', 'mjs', 'index.js'), join(PKG_ROOT, 'lib', 'cjs', 'index.js')]) {
          if (!existsSync(f)) throw new Error(`${f} is missing; run the authn-session pretest (mjs and cjs compile)`);
        }
        esm = probe(
          'module',
          `const snapshot = ${SNAPSHOT};
           const exercise = ${EXERCISE};
           const di = await import('@spinajs/di');
           await import('@spinajs/configuration');
           await import('@spinajs/authn/contracts');
           await import('luxon');
           const before = snapshot(di);
           const m = await import('@spinajs/authn-session');
           const after = snapshot(di);
           console.log(JSON.stringify({ before, after, exercise: exercise(di, m) }));`,
        );
        cjs = probe(
          'commonjs',
          `const snapshot = ${SNAPSHOT};
           const exercise = ${EXERCISE};
           const di = require('@spinajs/di');
           require('@spinajs/configuration');
           require('@spinajs/authn/contracts');
           require('luxon');
           const before = snapshot(di);
           const m = require('@spinajs/authn-session');
           const after = snapshot(di);
           console.log(JSON.stringify({ before, after, exercise: exercise(di, m) }));`,
        );
      });

      const expectOnlyOwnRegistrations = (p: Probe) => {
        const before = p.before as Snapshot;
        const after = p.after as Snapshot;
        expect(delta(before.registry, after.registry)).to.deep.eq(EXPECTED_REGISTRATIONS);
        // @Config caches one value per decorated property: ttl of the three strategies, maxLifetime of the capped one and the pending TTL
        expect(delta(before.cache, after.cache)).to.deep.eq({ __configuration_property__: ['Object', 'Object', 'Object', 'Object', 'Object'] });
        expect(after.events).to.deep.eq(before.events);
      };

      it('ESM', () => {
        expectOnlyOwnRegistrations(esm);
        expect(esm.exercise).to.deep.eq({ keys: PUBLIC_EXPORTS, provider: EXPECTED_META, expiration: null, asyncService: true });
      });

      it('CJS', () => {
        expectOnlyOwnRegistrations(cjs);
        expect(cjs.exercise).to.deep.eq(esm.exercise);
      });
    });
  });
});
