import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as express from 'express';
import { Container } from '@spinajs/di';
import { BasePolicy, CsrfGuard, Ip, ServerMiddleware, Route } from '@spinajs/http';
import type { IActionLocalStoregeContext, IController, IRoute, Request } from '@spinajs/http';
import type { AuthnContext, AuthnFacts, Credentials, IdentityRef, Principal, Session } from '@spinajs/authn/contracts';

import * as api from '../src/api.js';
import { AuthnPrincipalResolver } from '../src/api.js';
import type { AuthnIdentity } from '../src/api.js';
import * as barrel from '../src/index.js';
import { Authenticated, AuthnMiddleware, AuthnSession, ClientIp, CsrfOriginGuard, FreshAuth, FromSession, Identity, KeyPrincipalResolver, MfaSatisfied, NoImpersonationPolicy, NoSession, NoTokenAuthPolicy, NotLoggedPolicy, SessionId, SessionPrincipalResolver, TokenPrincipalResolver } from '../src/index.js';
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
const DESIGN_NAMES = [...Object.keys(POLICIES), ...Object.keys(ROUTE_ARGS), ...Object.keys(MIDDLEWARES), 'AuthnPrincipalResolver', ...Object.keys(RESOLVERS)].sort();
const RUNTIME_EXPORTS = ['AuthnPrincipalResolver'];

type ResolveResult = Promise<Principal | null | undefined>;
type Handler = (req: Request, res: express.Response, next: express.NextFunction) => void;

interface MemberShape {
  name: string;
  kind: 'constructor' | 'method' | 'property';
  modifiers: string[];
  params: string[] | null;
}

function sourceShape() {
  const sf = ts.createSourceFile(API_SRC, readFileSync(API_SRC, 'utf8'), ts.ScriptTarget.Latest, true);
  const classes: Record<string, { base: string | null; abstract: boolean; doc: string; members: MemberShape[] }> = {};
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
  });
  const specifiers = ts.preProcessFile(readFileSync(API_SRC, 'utf8'), true, true).importedFiles.map((f) => f.fileName);
  return { classes, specifiers, text: sf.getFullText() };
}

// Plain JS for the child process. Reads DI
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

describe('authn-http contracts (api.ts)', function () {
  this.timeout(60000);

  describe('exports', () => {
    it('api.ts exports only the resolver contract at runtime', () => {
      expect(Object.keys(api).sort()).to.deep.eq(RUNTIME_EXPORTS);
    });

    it('policies extend BasePolicy, middlewares ServerMiddleware, resolvers AuthnPrincipalResolver', () => {
      for (const p of Object.values(POLICIES)) expect(Object.getPrototypeOf(p), p.name).to.eq(BasePolicy);
      for (const m of Object.values(MIDDLEWARES)) expect(m.prototype, m.name).to.be.instanceOf(ServerMiddleware);
      expect(Object.getPrototypeOf(CsrfOriginGuard), 'the authn guard is the @spinajs/http CsrfGuard plus the session cookie').to.eq(CsrfGuard);
      for (const r of Object.values(RESOLVERS)) expect(Object.getPrototypeOf(r), r.name).to.eq(AuthnPrincipalResolver);
      expect(Object.getPrototypeOf(AuthnPrincipalResolver)).to.eq(Function.prototype);
      for (const f of Object.values(ROUTE_ARGS)) expect(f).to.be.a('function');
    });

    it('the barrel and the v3 sub-entry export the same implementation under every design name', () => {
      const b = barrel as unknown as Record<string, unknown>;
      const sub = v3 as unknown as Record<string, unknown>;
      for (const n of DESIGN_NAMES) expect(b[n], n).to.be.a('function').and.eq(sub[n]);
      expect(b.AuthnPrincipalResolver).to.eq(AuthnPrincipalResolver);
    });

    it('imports only @spinajs/authn/contracts and @spinajs/http', () => {
      expect([...new Set(sourceShape().specifiers)].sort()).to.deep.eq(['@spinajs/authn/contracts', '@spinajs/http']);
    });
  });

  describe('implementations', () => {
    it('@Policy(FreshAuth, 600) reaches the constructor through container.resolve(Type, options)', () => {
      const p = new Container().resolve(FreshAuth, [600]) as FreshAuth;
      expect(p).to.be.instanceOf(FreshAuth);
      expect(p.maxAgeSeconds).to.eq(600);
    });

    it('middlewares run ClientIp, then CsrfOriginGuard, then AuthnMiddleware, after the http built-ins (<= 3)', () => {
      expect([new ClientIp().Order, new CsrfOriginGuard().Order, new AuthnMiddleware().Order]).to.deep.eq([1, 4, 5]);
    });

    it('resolvers are asked key (45), token (50), session (100)', () => {
      expect([new KeyPrincipalResolver().order, new TokenPrincipalResolver().order, new SessionPrincipalResolver().order]).to.deep.eq([45, 50, 100]);
    });
  });

  describe('source shape', () => {
    it('classes', () => {
      const shapes = Object.fromEntries(Object.entries(sourceShape().classes).map(([k, v]) => [k, { base: v.base, abstract: v.abstract, members: v.members }]));
      expect(shapes).to.deep.eq({
        AuthnPrincipalResolver: {
          base: null,
          abstract: true,
          members: [
            { name: 'order', kind: 'property', modifiers: ['abstract', 'readonly'], params: null },
            { name: 'resolve', kind: 'method', modifiers: ['abstract'], params: ['req', 'credentials', 'ctx'] },
          ],
        },
      });
    });

    it('docs state the resolver rules and that a session is not authentication', () => {
      const { classes: c, text } = sourceShape();
      expect(c.AuthnPrincipalResolver.doc).to.contain('undefined');
      expect(c.AuthnPrincipalResolver.doc).to.contain('null');
      expect(c.AuthnPrincipalResolver.doc).to.contain('AuthnService.authenticate(credentials, ctx)');
      expect(c.AuthnPrincipalResolver.doc).to.contain('AuthnService.principalOf');
      expect(text).to.contain('check handle.state; only AuthnPrincipal means authenticated (SR-07)');
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
      same<Request['storage']['AuthnSession'], Session | null | undefined>(true);
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
    const BUILT = join(PKG_ROOT, 'lib', 'api.js');

    before(() => {
      if (!existsSync(BUILT)) throw new Error(`${BUILT} is missing; run the authn-http pretest`);
    });

    it('importing api.js registers nothing in the root container', () => {
      const r = probe(
        'module',
        `const snapshot = ${SNAPSHOT};
         const di = await import('@spinajs/di');
         await import('@spinajs/http');
         await import('@spinajs/authn/contracts');
         await import('express');
         const before = snapshot(di);
         const api = await import(${JSON.stringify(pathToFileURL(BUILT).href)});
         const after = snapshot(di);
         console.log(JSON.stringify({ before, after, keys: Object.keys(api).sort() }));`,
      );
      expect(r.keys).to.deep.eq(RUNTIME_EXPORTS);
      expect(r.before.registry, 'probe saw an empty registry').to.not.be.empty;
      expect(r.after).to.deep.eq(r.before);
    });
  });
});