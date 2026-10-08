import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as express from 'express';
import { Container } from '@spinajs/di';
import { BasePolicy, Ip, ServerMiddleware, Route } from '@spinajs/http';
import type { IActionLocalStoregeContext, IController, IRoute, Request } from '@spinajs/http';
import type { AuthnContext, AuthnFacts, Credentials, IdentityRef, Principal, SessionHandle } from '@spinajs/authn/contracts';

import * as api from '../src/api.js';
import { Authenticated, AuthnMiddleware, AuthnPrincipalResolver, AuthnSession, ClientIp, CsrfOriginGuard, FreshAuth, FromSession, Identity, KeyPrincipalResolver, MfaSatisfied, NoImpersonationPolicy, NoSession, NoTokenAuthPolicy, NotLoggedPolicy, SessionId, SessionPrincipalResolver, TokenPrincipalResolver } from '../src/api.js';
import type { AuthnIdentity } from '../src/api.js';
import * as barrel from '../src/index.js';
import { ClientIp as LaneClientIp } from '../src/middleware/client-ip.js';
import { CsrfOriginGuard as LaneCsrfOriginGuard } from '../src/middleware/csrf.js';
import { AuthnMiddleware as LaneAuthnMiddleware } from '../src/middleware/authn.js';
import { KeyPrincipalResolver as LaneKeyPrincipalResolver, TokenPrincipalResolver as LaneTokenPrincipalResolver } from '../src/resolvers/credential.js';
import { SessionPrincipalResolver as LaneSessionPrincipalResolver } from '../src/resolvers/session.js';
import { Authenticated as LaneAuthenticated, NoImpersonationPolicy as LaneNoImpersonationPolicy, NoSession as LaneNoSession, NoTokenAuthPolicy as LaneNoTokenAuthPolicy, NotLoggedPolicy as LaneNotLoggedPolicy } from '../src/policies/v3/principal.js';
import { FreshAuth as LaneFreshAuth } from '../src/policies/v3/fresh-auth.js';
import { MfaSatisfied as LaneMfaSatisfied } from '../src/policies/v3/mfa.js';
import { AuthnSession as LaneAuthnSession, FromSession as LaneFromSession, Identity as LaneIdentity, SessionId as LaneSessionId } from '../src/args/authn.js';
import * as v3 from '../src/v3/index.js';

const expect = chai.expect;

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>): Equals<A, B> => ok;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_SRC = join(PKG_ROOT, 'src', 'api.ts');

const POLICIES = { Authenticated, FreshAuth, MfaSatisfied, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy };
const ROUTE_ARGS = { Identity, AuthnSession, SessionId, FromSession };
const MIDDLEWARES = { ClientIp, CsrfOriginGuard, AuthnMiddleware };
const RESOLVERS = { KeyPrincipalResolver, TokenPrincipalResolver, SessionPrincipalResolver };
// api.ts names N8a has implemented: the barrel must give these, not the stubs.
const LANE: Record<string, unknown> = {
  ClientIp: LaneClientIp,
  CsrfOriginGuard: LaneCsrfOriginGuard,
  AuthnMiddleware: LaneAuthnMiddleware,
  KeyPrincipalResolver: LaneKeyPrincipalResolver,
  TokenPrincipalResolver: LaneTokenPrincipalResolver,
  SessionPrincipalResolver: LaneSessionPrincipalResolver,
  Authenticated: LaneAuthenticated,
  FreshAuth: LaneFreshAuth,
  MfaSatisfied: LaneMfaSatisfied,
  NoSession: LaneNoSession,
  NotLoggedPolicy: LaneNotLoggedPolicy,
  NoTokenAuthPolicy: LaneNoTokenAuthPolicy,
  NoImpersonationPolicy: LaneNoImpersonationPolicy,
  Identity: LaneIdentity,
  AuthnSession: LaneAuthnSession,
  SessionId: LaneSessionId,
  FromSession: LaneFromSession,
};
// Since the N8c cutover the barrel keeps no 2.x code under an api.ts name.
const KEPT_2X: string[] = [];
const RUNTIME_EXPORTS = [...Object.keys(POLICIES), ...Object.keys(ROUTE_ARGS), ...Object.keys(MIDDLEWARES), 'AuthnPrincipalResolver', ...Object.keys(RESOLVERS)].sort();

type RestoredSession = { handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data: ReadonlyMap<string, unknown> };
type ResolveResult = Promise<Principal | null | undefined>;
type Handler = (req: Request, res: express.Response, next: express.NextFunction) => void;

const route = {} as IRoute;
const controller = {} as IController;
const req = { storage: {} } as unknown as Request;
const ctx: AuthnContext = { now: new Date(), purpose: 'request' };
const bearer: Credentials = { kind: 'bearer', token: 'spt_x' };

interface MemberShape {
  name: string;
  kind: 'constructor' | 'method' | 'property';
  modifiers: string[];
  params: string[] | null;
}

function sourceShape() {
  const sf = ts.createSourceFile(API_SRC, readFileSync(API_SRC, 'utf8'), ts.ScriptTarget.Latest, true);
  const classes: Record<string, { base: string | null; abstract: boolean; doc: string; members: MemberShape[] }> = {};
  const functions: Record<string, { params: string[]; doc: string }> = {};
  const exported = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const doc = (n: ts.Node) =>
    ts
      .getJSDocCommentsAndTags(n)
      .map((d) => d.getText(sf).replace(/[ \t]*\r?\n[ \t]*\*(?!\/)[ \t]*/g, ' '))
      .join(' ');
  sf.forEachChild((n) => {
    if (ts.isClassDeclaration(n) && n.name && exported(n)) {
      const heritage = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      classes[n.name.text] = {
        base: heritage ? heritage.types[0].expression.getText(sf) : null,
        abstract: (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.AbstractKeyword),
        doc: doc(n),
        members: n.members.map((m) => ({
          name: ts.isConstructorDeclaration(m) ? 'constructor' : m.name!.getText(sf),
          kind: ts.isConstructorDeclaration(m) ? 'constructor' : ts.isMethodDeclaration(m) ? 'method' : 'property',
          modifiers: (ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).map((x) => x.getText(sf)),
          params: ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m) ? m.parameters.map((p) => p.name.getText(sf)) : null,
        })),
      };
    }
    if (ts.isFunctionDeclaration(n) && n.name && exported(n)) {
      functions[n.name.text] = { params: n.parameters.map((p) => p.name.getText(sf)), doc: doc(n) };
    }
  });
  const specifiers = ts.preProcessFile(readFileSync(API_SRC, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
  return { classes, functions, specifiers, text: sf.getFullText() };
}

const notImplemented = (fn: () => unknown, member: string) => expect(fn).to.throw(Error).with.property('message', `not implemented: ${member}`);

// Plain JS so the same code runs in the ESM and the CJS child. Reads DI
// internals so a registration made at load time cannot hide behind the API.
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

interface ProbeResult {
  before: { registry: unknown[] };
  after: unknown;
  keys: string[];
  added?: string[];
}

function probe(inputType: 'module' | 'commonjs', body: string): ProbeResult {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`child node (${inputType}) exited with ${r.status}:\n${r.stderr}`);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]) as ProbeResult;
}

describe('authn-http api stubs (api.ts)', function () {
  this.timeout(60000);

  describe('exports', () => {
    it('exports exactly the design names at runtime', () => {
      expect(Object.keys(api).sort()).to.deep.eq(RUNTIME_EXPORTS);
    });

    it('policies extend BasePolicy, middlewares ServerMiddleware, resolvers AuthnPrincipalResolver', () => {
      for (const p of Object.values(POLICIES)) expect(Object.getPrototypeOf(p), p.name).to.eq(BasePolicy);
      for (const m of Object.values(MIDDLEWARES)) expect(Object.getPrototypeOf(m), m.name).to.eq(ServerMiddleware);
      for (const r of Object.values(RESOLVERS)) expect(Object.getPrototypeOf(r), r.name).to.eq(AuthnPrincipalResolver);
      expect(Object.getPrototypeOf(AuthnPrincipalResolver)).to.eq(Function.prototype);
      for (const f of Object.values(ROUTE_ARGS)) expect(f).to.be.a('function');
    });

    it('every api name has a lane implementation, and the v3 sub-entry exports each one, the five colliding names included', () => {
      expect(Object.keys(LANE).sort()).to.deep.eq(RUNTIME_EXPORTS.filter((n) => n !== 'AuthnPrincipalResolver'));
      const sub = v3 as unknown as Record<string, unknown>;
      for (const n of Object.keys(LANE)) expect(sub[n], n).to.eq(LANE[n]).and.not.eq((api as Record<string, unknown>)[n]);
      expect(sub.AuthnPrincipalResolver).to.eq(AuthnPrincipalResolver);
    });

    it('the barrel exports every api name as the lane implementation, the five names the 2.x code also has included (N8c)', () => {
      const b = barrel as unknown as Record<string, unknown>;
      for (const n of RUNTIME_EXPORTS.filter((x) => !KEPT_2X.includes(x))) {
        const stub = (api as Record<string, unknown>)[n];
        if (n in LANE) expect(b[n], n).to.eq(LANE[n]).and.not.eq(stub);
        else expect(b[n], n).to.eq(stub);
      }
    });

    it('imports only @spinajs/authn/contracts, @spinajs/http and express', () => {
      expect([...new Set(sourceShape().specifiers)].sort()).to.deep.eq(['@spinajs/authn/contracts', '@spinajs/http', 'express']);
    });
  });

  describe('stubs', () => {
    const calls: [string, () => unknown][] = [
      ...Object.values(POLICIES).flatMap((P): [string, () => unknown][] => [
        [`${P.name}.isEnabled`, () => new P().isEnabled(route, controller)],
        [`${P.name}.execute`, () => new P().execute(req, route, controller)],
      ]),
      ['Identity', () => Identity()],
      ['AuthnSession', () => AuthnSession()],
      ['SessionId', () => SessionId()],
      ['FromSession', () => FromSession('cart')],
      ...Object.values(MIDDLEWARES).flatMap((M): [string, () => unknown][] => [
        [`${M.name}.before`, () => new M().before()],
        [`${M.name}.after`, () => new M().after()],
      ]),
      ...Object.values(RESOLVERS).map((R): [string, () => unknown] => [`${R.name}.resolve`, () => new R().resolve(req, bearer, ctx)]),
    ];

    for (const [member, call] of calls) {
      it(`${member} throws not implemented`, () => notImplemented(call, member));
    }

    it('the list above covers every method and exported function of api.ts', () => {
      const { classes, functions } = sourceShape();
      const fromSource = [...Object.entries(classes).flatMap(([c, s]) => s.members.filter((m) => m.kind === 'method' && !m.modifiers.includes('abstract')).map((m) => `${c}.${m.name}`)), ...Object.keys(functions)];
      expect(calls.map(([m]) => m).sort()).to.deep.eq(fromSource.sort());
    });

    it('one private helper throws for all of them', () => {
      const { text } = sourceShape();
      expect(text.match(/\bthrow\b/g)).to.have.length(1);
      expect(text).to.contain('not implemented: ');
    });

    it('constructors do no work beyond storing their arguments and Order', () => {
      expect(new FreshAuth().maxAgeSeconds).to.eq(undefined);
      expect(new FreshAuth(600).maxAgeSeconds).to.eq(600);
      for (const P of Object.values(POLICIES)) expect(() => new P()).to.not.throw();
    });

    it('@Policy(FreshAuth, 600) reaches the constructor through container.resolve(Type, options)', () => {
      const p = new Container().resolve(FreshAuth, [600]) as FreshAuth;
      expect(p).to.be.instanceOf(FreshAuth);
      expect(p.maxAgeSeconds).to.eq(600);
      const lane = new Container().resolve(LaneFreshAuth, [600]) as LaneFreshAuth;
      expect(lane).to.be.instanceOf(LaneFreshAuth);
      expect(lane.maxAgeSeconds).to.eq(600);
    });

    it('middlewares run ClientIp, then CsrfOriginGuard, then AuthnMiddleware, after the http built-ins (<= 3)', () => {
      expect([new ClientIp().Order, new CsrfOriginGuard().Order, new AuthnMiddleware().Order]).to.deep.eq([1, 4, 5]);
    });

    it('resolvers are asked key (45), token (50), session (100)', () => {
      expect([new KeyPrincipalResolver().order, new TokenPrincipalResolver().order, new SessionPrincipalResolver().order]).to.deep.eq([45, 50, 100]);
    });
  });

  describe('source shape (names, modifiers, parameter names)', () => {
    const policy = (ctor: string[] | null) => ({
      base: 'BasePolicy',
      abstract: false,
      members: [...(ctor ? [{ name: 'constructor', kind: 'constructor', modifiers: [], params: ctor }] : []), { name: 'isEnabled', kind: 'method', modifiers: ['public'], params: ['action', 'instance'] }, { name: 'execute', kind: 'method', modifiers: ['public'], params: ['req', 'action', 'instance'] }],
    });
    const middleware = {
      base: 'ServerMiddleware',
      abstract: false,
      members: [
        { name: 'constructor', kind: 'constructor', modifiers: [], params: [] },
        { name: 'before', kind: 'method', modifiers: ['public'], params: [] },
        { name: 'after', kind: 'method', modifiers: ['public'], params: [] },
      ],
    };
    const resolver = {
      base: 'AuthnPrincipalResolver',
      abstract: false,
      members: [
        { name: 'order', kind: 'property', modifiers: ['public', 'readonly'], params: null },
        { name: 'resolve', kind: 'method', modifiers: ['public'], params: ['req', 'credentials', 'ctx'] },
      ],
    };

    it('classes', () => {
      const shapes = Object.fromEntries(Object.entries(sourceShape().classes).map(([k, v]) => [k, { base: v.base, abstract: v.abstract, members: v.members }]));
      expect(shapes).to.deep.eq({
        Authenticated: policy(null),
        FreshAuth: policy(['maxAgeSeconds']),
        MfaSatisfied: policy(null),
        NoSession: policy(null),
        NotLoggedPolicy: policy(null),
        NoTokenAuthPolicy: policy(null),
        NoImpersonationPolicy: policy(null),
        ClientIp: middleware,
        CsrfOriginGuard: middleware,
        AuthnMiddleware: middleware,
        AuthnPrincipalResolver: {
          base: null,
          abstract: true,
          members: [
            { name: 'order', kind: 'property', modifiers: ['abstract', 'readonly'], params: null },
            { name: 'resolve', kind: 'method', modifiers: ['abstract'], params: ['req', 'credentials', 'ctx'] },
          ],
        },
        KeyPrincipalResolver: resolver,
        TokenPrincipalResolver: resolver,
        SessionPrincipalResolver: resolver,
      });
    });

    it('route-arg functions', () => {
      const f = sourceShape().functions;
      expect(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.params]))).to.deep.eq({ Identity: [], AuthnSession: [], SessionId: [], FromSession: ['key'] });
    });

    it('docs state what each piece does and the rules it carries', () => {
      const { classes: c, functions: f } = sourceShape();
      expect(c.Authenticated.doc).to.contain('pending');
      expect(c.FreshAuth.doc).to.contain('authn.freshAuth.maxAgeSeconds');
      expect(c.FreshAuth.doc).to.contain('A13');
      expect(c.FreshAuth.doc).to.contain('principal.authn.sessionHandle is set');
      expect(c.FreshAuth.doc).to.contain('AuthnService.reauthenticate(session, credentials, ctx)');
      expect(c.FreshAuth.doc).to.contain("purpose 'reauth'");
      expect(c.FreshAuth.doc).to.contain('SR-20');
      expect(c.FreshAuth.doc).to.contain('requirePassword');
      expect(c.MfaSatisfied.doc).to.contain('aal2');
      expect(c.NoTokenAuthPolicy.doc).to.contain('token');
      expect(c.NoImpersonationPolicy.doc).to.contain('impersonat');
      expect(c.ClientIp.doc).to.contain('trusted');
      expect(c.ClientIp.doc).to.contain('Order 1');
      expect(c.CsrfOriginGuard.doc).to.contain('A22');
      expect(c.CsrfOriginGuard.doc).to.contain('Order 4');
      expect(c.CsrfOriginGuard.doc).to.contain('authn.http.csrf.enabled');
      expect(c.CsrfOriginGuard.doc).to.contain('may still check the routes that issue a session');
      expect(c.AuthnMiddleware.doc).to.contain('Order 5');
      expect(c.AuthnMiddleware.doc).to.contain('req.storage.AuthnPrincipal');
      expect(c.AuthnPrincipalResolver.doc).to.contain('undefined');
      expect(c.AuthnPrincipalResolver.doc).to.contain('null');
      expect(c.AuthnPrincipalResolver.doc).to.contain('AuthnService.authenticate(credentials, ctx)');
      expect(c.AuthnPrincipalResolver.doc).to.contain('AuthnService.principalOf');
      expect(c.SessionPrincipalResolver.doc).to.contain('Pending ⇒ null');
      expect(c.TokenPrincipalResolver.doc).to.contain('ceiling.roles');
      expect(c.TokenPrincipalResolver.doc).to.contain('attributes.profile: TokenStrategy puts it in StrategyOutcome.attributes and principalOf merges it');
      expect(c.KeyPrincipalResolver.doc).to.contain('scope');
      for (const n of Object.keys(ROUTE_ARGS)) expect(f[n].doc, n).to.match(/null|undefined/);
      for (const n of ['AuthnSession', 'SessionId', 'FromSession']) expect(f[n].doc, n).to.match(/not authentication/i);
      expect(f.AuthnSession.doc).to.contain('check handle.state');
      expect(sourceShape().text).to.contain('check handle.state; only AuthnPrincipal means authenticated (SR-07)');
    });
  });

  describe('types', () => {
    it('policies keep the BasePolicy members, typed with the spinajs Request', () => {
      same<Parameters<Authenticated['isEnabled']>, [IRoute, IController]>(true);
      same<ReturnType<Authenticated['isEnabled']>, boolean>(true);
      same<Parameters<Authenticated['execute']>, [Request, IRoute, IController]>(true);
      same<ReturnType<Authenticated['execute']>, Promise<void>>(true);
      same<Authenticated['execute'], FreshAuth['execute']>(true);
      same<Authenticated['execute'], MfaSatisfied['execute']>(true);
      same<Authenticated['execute'], NoSession['execute']>(true);
      same<Authenticated['execute'], NotLoggedPolicy['execute']>(true);
      same<Authenticated['execute'], NoTokenAuthPolicy['execute']>(true);
      same<Authenticated['execute'], NoImpersonationPolicy['execute']>(true);
      const asBase: BasePolicy[] = [new Authenticated(), new FreshAuth(), new MfaSatisfied(), new NoSession(), new NotLoggedPolicy(), new NoTokenAuthPolicy(), new NoImpersonationPolicy()];
      expect(asBase).to.have.length(7);
    });

    it('only FreshAuth takes an option: maxAgeSeconds in seconds, optional', () => {
      same<ConstructorParameters<typeof FreshAuth>, [maxAgeSeconds?: number]>(true);
      same<FreshAuth['maxAgeSeconds'], number | undefined>(true);
      same<ConstructorParameters<typeof Authenticated>, []>(true);
      same<ConstructorParameters<typeof MfaSatisfied>, []>(true);
      same<ConstructorParameters<typeof NoSession>, []>(true);
      same<ConstructorParameters<typeof NotLoggedPolicy>, []>(true);
      same<ConstructorParameters<typeof NoTokenAuthPolicy>, []>(true);
      same<ConstructorParameters<typeof NoImpersonationPolicy>, []>(true);
      const f = new FreshAuth(60);
      // @ts-expect-error readonly
      f.maxAgeSeconds = 1;
      // @ts-expect-error seconds, a number
      const g = () => new FreshAuth('5m');
      expect(g).to.be.a('function');
    });

    it('route args return what @spinajs/http parameter decorators return', () => {
      same<ReturnType<typeof Identity>, ReturnType<typeof Route>>(true);
      same<ReturnType<typeof Identity>, ReturnType<typeof Ip>>(true);
      same<ReturnType<typeof AuthnSession>, ReturnType<typeof Route>>(true);
      same<ReturnType<typeof SessionId>, ReturnType<typeof Route>>(true);
      same<ReturnType<typeof FromSession>, ReturnType<typeof Route>>(true);
      same<Parameters<typeof Identity>, []>(true);
      same<Parameters<typeof AuthnSession>, []>(true);
      same<Parameters<typeof SessionId>, []>(true);
      same<Parameters<typeof FromSession>, [key: string]>(true);
      // @ts-expect-error 3.0 takes the session data key
      const a = () => FromSession();
      expect(a).to.be.a('function');
    });

    it('@Identity() resolves to AuthnIdentity: the IdentityRef and its AuthnFacts', () => {
      same<AuthnIdentity, { readonly identity: IdentityRef; readonly facts: AuthnFacts }>(true);
    });

    it('middlewares type before() and after() exactly as ServerMiddleware does', () => {
      same<ReturnType<ClientIp['before']>, ReturnType<ServerMiddleware['before']>>(true);
      same<ReturnType<ClientIp['after']>, ReturnType<ServerMiddleware['after']>>(true);
      same<ReturnType<CsrfOriginGuard['before']>, Handler | null>(true);
      same<ReturnType<CsrfOriginGuard['after']>, Handler | express.ErrorRequestHandler | null>(true);
      same<ReturnType<AuthnMiddleware['before']>, ReturnType<ServerMiddleware['before']>>(true);
      same<ReturnType<AuthnMiddleware['after']>, ReturnType<ServerMiddleware['after']>>(true);
      const asBase: ServerMiddleware[] = [new ClientIp(), new CsrfOriginGuard(), new AuthnMiddleware()];
      expect(asBase).to.have.length(3);
    });

    it('the resolver contract', () => {
      same<AuthnPrincipalResolver['order'], number>(true);
      same<Parameters<AuthnPrincipalResolver['resolve']>, [Request, Credentials | null, AuthnContext]>(true);
      same<ReturnType<AuthnPrincipalResolver['resolve']>, ResolveResult>(true);
      same<KeyPrincipalResolver['resolve'], AuthnPrincipalResolver['resolve']>(true);
      same<TokenPrincipalResolver['resolve'], AuthnPrincipalResolver['resolve']>(true);
      same<SessionPrincipalResolver['resolve'], AuthnPrincipalResolver['resolve']>(true);
      const r: AuthnPrincipalResolver = new SessionPrincipalResolver();
      // @ts-expect-error readonly
      r.order = 1;
      // @ts-expect-error abstract
      const a = () => new AuthnPrincipalResolver();
      class Custom extends AuthnPrincipalResolver {
        readonly order = 10;
        async resolve(_req: Request, credentials: Credentials | null): ResolveResult {
          return credentials ? null : undefined;
        }
      }
      class Wrong extends AuthnPrincipalResolver {
        readonly order = 10;
        // @ts-expect-error a resolver answers a Principal, never a PrincipalRef
        async resolve(): Promise<{ type: string; id: string }> {
          return { type: 'user', id: 'x' };
        }
      }
      expect([a, Custom, Wrong]).to.have.length(3);
    });

    it('req.storage carries AuthnPrincipal, AuthnSession and ClientIp', () => {
      same<IActionLocalStoregeContext['AuthnPrincipal'], Principal | null | undefined>(true);
      same<Request['storage']['AuthnPrincipal'], Principal | null | undefined>(true);
      same<Request['storage']['AuthnSession'], RestoredSession | null | undefined>(true);
      same<Request['storage']['ClientIp'], string | undefined>(true);
      const s = {} as Request['storage'];
      s.AuthnPrincipal = null;
      s.AuthnSession = null;
      // @ts-expect-error a PrincipalRef is not a Principal
      s.AuthnPrincipal = { type: 'user', id: 'alice' };
      expect(s.AuthnPrincipal).to.deep.eq({ type: 'user', id: 'alice' });
    });
  });

  describe('DI', () => {
    const MJS = join(PKG_ROOT, 'lib', 'mjs', 'api.js');
    const CJS = join(PKG_ROOT, 'lib', 'cjs', 'api.js');

    before(() => {
      for (const f of [MJS, CJS]) {
        if (!existsSync(f)) throw new Error(`${f} is missing; run the authn-http pretest (mjs and cjs compile)`);
      }
    });

    it('ESM: importing api.js registers nothing in the root container', () => {
      const r = probe(
        'module',
        `const snapshot = ${SNAPSHOT};
         const di = await import('@spinajs/di');
         await import('@spinajs/http');
         await import('@spinajs/authn/contracts');
         await import('express');
         const before = snapshot(di);
         const api = await import(${JSON.stringify(pathToFileURL(MJS).href)});
         const after = snapshot(di);
         console.log(JSON.stringify({ before, after, keys: Object.keys(api).sort() }));`,
      );
      expect(r.keys).to.deep.eq(RUNTIME_EXPORTS);
      expect(r.before.registry, 'probe saw an empty registry').to.not.be.empty;
      expect(r.after).to.deep.eq(r.before);
    });

    it('CJS: requiring api.js registers nothing and loads no other authn-http file', () => {
      const r = probe(
        'commonjs',
        `const snapshot = ${SNAPSHOT};
         const di = require('@spinajs/di');
         require('@spinajs/http');
         require('@spinajs/authn/contracts');
         require('express');
         const before = snapshot(di);
         const initial = new Set(Object.keys(require.cache));
         const api = require(${JSON.stringify(CJS)});
         const added = Object.keys(require.cache).filter((k) => !initial.has(k));
         const after = snapshot(di);
         console.log(JSON.stringify({ before, after, keys: Object.keys(api).sort(), added }));`,
      );
      expect(r.keys).to.deep.eq(RUNTIME_EXPORTS);
      expect(r.before.registry, 'probe saw an empty registry').to.not.be.empty;
      expect(r.after).to.deep.eq(r.before);
      expect(r.added).to.deep.eq([CJS]);
    });
  });
});
