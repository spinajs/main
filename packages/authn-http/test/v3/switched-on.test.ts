import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Snapshot {
  AuthnService: string[];
  MfaPolicy: string[];
  AuthnThrottle: string[];
  CredentialExtractor: string[];
  AuthnPrincipalResolver: string[];
  ServerMiddleware: string[];
  RouteArgs: string[];
  Controllers: string[];
  /** Every registry key of the root container with the names registered under it. */
  registry: [string, string[]][];
}

interface Run {
  loaded: Snapshot;
  afterExplicitCall: Snapshot;
  n10: { body: unknown; functions: string[] };
  /** Per colliding name: the barrel gives the 3.0 class of ./v3/index.js, not the api.ts stub. */
  barrelIsV3: Record<string, boolean>;
  orders: { AuthnMiddleware: number };
  bridgeExported: boolean;
  tokenAuthMiddlewareExported: boolean;
  /** CJS only: loaded module files under v3/controllers; null in ESM, which lists no loaded modules. */
  loadedV3Controllers: string[] | null;
  /** The files of the shipped cli dir, loaded before the first snapshot as the CLI's scan loads them. */
  cliFiles: string[];
  /** CJS only: loaded module files of the @spinajs/authn build outside its contracts; null in ESM. */
  loadedAuthnRoot: string[] | null;
}

// Plain JS for the ESM and the CJS child: the built package, loaded as an app loads it.
const ROUTE_ARG_NAMES = ['AuthnIdentityArg', 'AuthnSessionArg', 'AuthnSessionIdArg', 'AuthnSessionDataArg'];

const COLLIDING = ['NotLoggedPolicy', 'NoTokenAuthPolicy', 'NoImpersonationPolicy', 'FromSession', 'SessionId'];

const V3_CONTROLLERS = ['AuthnLoginController', 'AuthnMfaController', 'AuthnSessionsController', 'AuthnActiveRoleController', 'AuthnImpersonationController'];

const BODY = `
  const ROUTE_ARGS = ${JSON.stringify(ROUTE_ARG_NAMES)};
  const COLLIDING = ${JSON.stringify(COLLIDING)};
  const names = (di, t) => (di.DI.getRegisteredTypes(t) ?? []).map((x) => x.name);
  const snap = (di, http, contracts, pkg) => ({
    AuthnService: names(di, contracts.AuthnService),
    MfaPolicy: names(di, contracts.MfaPolicy),
    AuthnThrottle: names(di, contracts.AuthnThrottle),
    CredentialExtractor: names(di, contracts.CredentialExtractor),
    AuthnPrincipalResolver: names(di, pkg.AuthnPrincipalResolver),
    ServerMiddleware: names(di, http.ServerMiddleware),
    RouteArgs: ROUTE_ARGS.filter((n) => di.DI.RootContainer.hasRegistered(n)),
    Controllers: names(di, http.BaseController),
    registry: [...di.DI.RootContainer.Registry.registry].map(([k, v]) => [k, v.map((x) => x.name)]),
  });
  const loaded = snap(di, http, contracts, pkg);
  const n10 = {
    body: pkg.AUTHN_FAILURE_BODY,
    functions: ['authnFailureResponse', 'authnSessionCookie', 'authnClearedSessionCookie'].filter((n) => typeof pkg[n] === 'function'),
  };
  const barrelIsV3 = Object.fromEntries(COLLIDING.map((n) => [n, typeof pkg[n] === 'function' && pkg[n] === v3[n] && pkg[n] !== api[n]]));
  const orders = { AuthnMiddleware: new pkg.AuthnMiddleware().Order };
  const bridgeExported = ['LegacyStorageBridge', 'RbacMiddleware', 'ITokenAuthInfo'].some((n) => n in pkg);
  const tokenAuthMiddlewareExported = 'TokenAuthMiddleware' in pkg;
  const loadedV3Controllers = typeof require === 'function' ? Object.keys(require.cache).filter((f) => /[\\\\/]v3[\\\\/]controllers[\\\\/]/.test(f)) : null;
  const loadedAuthnRoot = typeof require === 'function' ? Object.keys(require.cache).filter((f) => /[\\\\/]authn[\\\\/]lib[\\\\/]cjs[\\\\/]/.test(f) && !/[\\\\/]contracts[\\\\/]/.test(f)) : null;
  await pkg.registerAuthnHttpV3();
  console.log(JSON.stringify({ loaded, afterExplicitCall: snap(di, http, contracts, pkg), n10, barrelIsV3, orders, bridgeExported, tokenAuthMiddlewareExported, loadedV3Controllers, cliFiles, loadedAuthnRoot }));
`;

const ESM = `
  const di = await import('@spinajs/di');
  const http = await import('@spinajs/http');
  const contracts = await import('@spinajs/authn/contracts');
  const pkg = await import('@spinajs/authn-http');
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const v3 = await import(pathToFileURL(join(process.cwd(), 'lib', 'mjs', 'v3', 'index.js')).href);
  const api = await import(pathToFileURL(join(process.cwd(), 'lib', 'mjs', 'api.js')).href);
  const cliDir = join(process.cwd(), 'lib', 'mjs', 'cli');
  const cliFiles = readdirSync(cliDir).filter((f) => f.endsWith('.js'));
  for (const f of cliFiles) await import(pathToFileURL(join(cliDir, f)).href);
  ${BODY}
`;

const CJS = `
  (async () => {
    const di = require('@spinajs/di');
    const http = require('@spinajs/http');
    const contracts = require('@spinajs/authn/contracts');
    const pkg = require('@spinajs/authn-http');
    const { readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const v3 = require(join(process.cwd(), 'lib', 'cjs', 'v3', 'index.js'));
    const api = require(join(process.cwd(), 'lib', 'cjs', 'api.js'));
    const cliDir = join(process.cwd(), 'lib', 'cjs', 'cli');
    const cliFiles = readdirSync(cliDir).filter((f) => f.endsWith('.js'));
    for (const f of cliFiles) require(join(cliDir, f));
    ${BODY}
  })().catch((e) => { console.error(e); process.exit(1); });
`;

// An app that never imports the barrel loads the package through its controller scan: a scanned 3.0 controller
// imports v3/index.js.
const SCAN_ENTRY = (entry: string) => `
  const di = await import('@spinajs/di');
  const http = await import('@spinajs/http');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  await import(pathToFileURL(join(process.cwd(), 'lib', 'mjs', ${JSON.stringify(entry)})).href);
  console.log(JSON.stringify((di.DI.getRegisteredTypes(http.ServerMiddleware) ?? []).map((t) => t.name)));
`;

// The cached object stands in for the server Controllers constructs before its scan; a real HttpServer needs a whole
// app configuration.
const LATE_LOAD = (serverFirst: boolean) => `
  const di = await import('@spinajs/di');
  const http = await import('@spinajs/http');
  const { Log } = await import('@spinajs/log');
  const errors = [];
  class CapturingLog {
    constructor(name) { this.Name = name; }
    error(m) { errors.push(String(m)); }
    warn() {} info() {} debug() {} trace() {} success() {} fatal() {} security() {}
  }
  di.DI.register(CapturingLog).as(Log);
  if (${serverFirst}) di.DI.RootContainer.Cache.add(http.HttpServer, { standIn: true });
  await import('@spinajs/authn-http');
  console.log(JSON.stringify(errors));
`;

function run<T = Run>(inputType: 'module' | 'commonjs', body: string): T {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

/** Every source file the barrel reaches through relative imports and re-exports. */
function barrelGraph(): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) visit(join(dirname(file), m[1].replace(/\.js$/, '.ts')));
  };
  visit(join(PKG_ROOT, 'src', 'index.ts'));
  return seen;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const count = (list: string[], name: string) => list.filter((n) => n === name).length;

describe('the 3.0 authn layer is switched on when the package loads (N8c)', function () {
  this.timeout(120000);

  for (const [label, inputType, body] of [
    ['ESM', 'module', ESM],
    ['CJS', 'commonjs', CJS],
  ] as const) {
    describe(label, () => {
      let r: Run;

      before(() => {
        r = run(inputType, body);
      });

      it('importing the package registers the authn services, AuthnMiddleware once, the extractors, resolvers, route args, and no 2.x middleware', () => {
        expect(r.cliFiles, 'the shipped cli dir').to.include('AuthnCheckConfig.js');
        if (r.loadedAuthnRoot !== null) expect(r.loadedAuthnRoot, 'modules of the @spinajs/authn root').to.not.be.empty;
        expect(r.loaded.AuthnService).to.include('DefaultAuthnService');
        expect(r.loaded.MfaPolicy).to.include('DefaultMfaPolicy');
        expect(r.loaded.AuthnThrottle).to.include('MemoryAuthnThrottle');
        expect(r.loaded.CredentialExtractor).to.have.members(['HttpSignatureExtractor', 'AuthorizationBearerExtractor', 'ApiKeyHeaderExtractor']);
        expect(r.loaded.AuthnPrincipalResolver).to.have.members(['KeyPrincipalResolver', 'TokenPrincipalResolver', 'SessionPrincipalResolver']);
        expect(r.loaded.RouteArgs).to.deep.eq(ROUTE_ARG_NAMES);
        expect(count(r.loaded.ServerMiddleware, 'AuthnMiddleware'), 'AuthnMiddleware once').to.eq(1);
        expect(r.loaded.ServerMiddleware).to.not.include('LegacyStorageBridge');
        expect(r.loaded.ServerMiddleware).to.not.include('RbacMiddleware');
        expect(r.loaded.ServerMiddleware).to.not.include('TokenAuthMiddleware');
      });

      it('registerAuthnHttpV3() after the import adds nothing', () => {
        expect(r.afterExplicitCall).to.deep.eq(r.loaded);
      });

      it('the barrel gives the 3.0 classes under the five colliding names; AuthnMiddleware runs at order 5; no request-keys bridge, no RbacMiddleware alias, no TokenAuthMiddleware', () => {
        expect(r.barrelIsV3).to.deep.eq(Object.fromEntries(COLLIDING.map((n) => [n, true])));
        expect(r.orders).to.deep.eq({ AuthnMiddleware: 5 });
        expect(r.bridgeExported).to.eq(false);
        expect(r.tokenAuthMiddlewareExported).to.eq(false);
      });

      it('no 3.0 controller is registered or loaded by the import (the app scans src/v3/controllers); the N10 helpers stay exported', () => {
        expect(r.loaded.Controllers).to.not.include.members(V3_CONTROLLERS);
        expect(r.afterExplicitCall.Controllers).to.not.include.members(V3_CONTROLLERS);
        if (r.loadedV3Controllers !== null) expect(r.loadedV3Controllers, 'loaded 3.0 controller modules').to.deep.eq([]);
        expect(r.n10.body, 'N10: the one 401 body, from the barrel').to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect' });
        expect(r.n10.functions, 'N10: the cookie helpers, from the barrel').to.deep.eq(['authnFailureResponse', 'authnSessionCookie', 'authnClearedSessionCookie']);
      });
    });
  }

  it('loading only v3/index.js, as the controller scan does, registers AuthnMiddleware and no bridge', () => {
    const middlewares = run<string[]>('module', SCAN_ENTRY('v3/index.js'));
    expect(count(middlewares, 'AuthnMiddleware')).to.eq(1);
    expect(count(middlewares, 'LegacyStorageBridge')).to.eq(0);
  });

  it('loaded after HttpServer was resolved (too late to join its middlewares), it logs an error naming the fix', () => {
    const errors = run<string[]>('module', LATE_LOAD(true));
    expect(errors).to.have.length(1);
    expect(errors[0]).to.include('import @spinajs/authn-http before resolving Controllers or HttpServer');
    expect(run<string[]>('module', LATE_LOAD(false)), 'loaded before the server').to.deep.eq([]);
  });

  it('the barrel reaches no file of src/v3/controllers, so no import loads a 3.0 controller', () => {
    const graph = [...barrelGraph()].map((f) => f.replace(/\\/g, '/'));
    expect(
      graph.some((f) => f.endsWith('/src/v3/responses.ts')),
      'the walk follows re-exports',
    ).to.eq(true);
    expect(graph.filter((f) => f.includes('/src/v3/controllers/'))).to.deep.eq([]);
    expect(graph.filter((f) => f.endsWith('/src/v3/routes.ts'))).to.deep.eq([]);
  });

  it('the barrel reaches no 2.x controller and no file importing the @spinajs/authn-totp root, which would register TotpService in every app (N8b task 9)', () => {
    const graph = [...barrelGraph()];
    expect(graph.filter((f) => /[\\/]src[\\/](account|token)[\\/]controllers[\\/]/.test(f))).to.deep.eq([]);
    expect(graph.filter((f) => /from\s+'@spinajs\/authn-totp'/.test(readFileSync(f, 'utf8'))).map((f) => f.replace(/\\/g, '/'))).to.deep.eq([]);
  });

  it('the barrel reaches no file importing @spinajs/users, so importing it registers none of its providers', () => {
    const graph = [...barrelGraph()];
    expect(graph.filter((f) => /(from\s+|import\s*\(?\s*)'@spinajs\/users(\/[^']*)?'/.test(readFileSync(f, 'utf8')))).to.deep.eq([]);
  });

  it('the 2.x session and token middlewares and the request-keys bridge are gone from the sources', () => {
    const defining = sourceFiles(join(PKG_ROOT, 'src')).filter((f) => /class (RbacMiddleware|TokenAuthMiddleware|LegacyStorageBridge)\b/.test(readFileSync(f, 'utf8')));
    expect(defining).to.deep.eq([]);
  });
});
