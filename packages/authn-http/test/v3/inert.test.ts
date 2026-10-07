import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
}

interface Run {
  before: Snapshot;
  after: Snapshot;
  n10: { body: unknown; functions: string[] };
  /** CJS only: loaded module files under v3/controllers; null in ESM, which lists no loaded modules. */
  loadedV3Controllers: string[] | null;
  /** The files of the shipped cli dir, loaded before the first snapshot as the CLI's scan loads them. */
  cliFiles: string[];
  /** CJS only: loaded module files of the @spinajs/authn build outside its contracts; null in ESM. */
  loadedAuthnRoot: string[] | null;
}

// Plain JS for the ESM and the CJS child: the built package, loaded as an app loads it.
const ROUTE_ARG_NAMES = ['AuthnIdentityArg', 'AuthnSessionArg', 'AuthnSessionIdArg', 'AuthnSessionDataArg'];

const V3_CONTROLLERS = ['AuthnLoginController', 'AuthnMfaController', 'AuthnSessionsController', 'AuthnActiveRoleController', 'AuthnImpersonationController'];

const BODY = `
  const ROUTE_ARGS = ${JSON.stringify(ROUTE_ARG_NAMES)};
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
  });
  const before = snap(di, http, contracts, pkg);
  const n10 = {
    body: pkg.AUTHN_FAILURE_BODY,
    functions: ['authnFailureResponse', 'authnSessionCookie', 'authnClearedSessionCookie'].filter((n) => typeof pkg[n] === 'function'),
  };
  const loadedV3Controllers = typeof require === 'function' ? Object.keys(require.cache).filter((f) => /[\\\\/]v3[\\\\/]controllers[\\\\/]/.test(f)) : null;
  const loadedAuthnRoot = typeof require === 'function' ? Object.keys(require.cache).filter((f) => /[\\\\/]authn[\\\\/]lib[\\\\/]cjs[\\\\/]/.test(f) && !/[\\\\/]contracts[\\\\/]/.test(f) && !/[\\\\/]service[\\\\/]boot[\\\\/]env\.js$/.test(f)) : null;
  await pkg.registerAuthnHttpV3();
  console.log(JSON.stringify({ before, after: snap(di, http, contracts, pkg), n10, loadedV3Controllers, cliFiles, loadedAuthnRoot }));
`;

const ESM = `
  const di = await import('@spinajs/di');
  const http = await import('@spinajs/http');
  const contracts = await import('@spinajs/authn/contracts');
  const pkg = await import('@spinajs/authn-http');
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
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
    const cliDir = join(process.cwd(), 'lib', 'cjs', 'cli');
    const cliFiles = readdirSync(cliDir).filter((f) => f.endsWith('.js'));
    for (const f of cliFiles) require(join(cliDir, f));
    ${BODY}
  })().catch((e) => { console.error(e); process.exit(1); });
`;

function run(inputType: 'module' | 'commonjs', body: string): Run {
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

describe('the 3.0 authn layer ships switched off (N8c)', function () {
  this.timeout(120000);

  for (const [label, inputType, body] of [
    ['ESM', 'module', ESM],
    ['CJS', 'commonjs', CJS],
  ] as const) {
    it(`${label}: importing the package and its cli dir registers no authn service, extractor, resolver, route arg, controller or AuthnMiddleware; registerAuthnHttpV3 does`, () => {
      const { before, after, n10, loadedV3Controllers, cliFiles, loadedAuthnRoot } = run(inputType, body);
      expect(cliFiles, 'the shipped cli dir').to.include('AuthnCheckConfig.js');
      if (loadedAuthnRoot !== null) expect(loadedAuthnRoot, 'modules of the @spinajs/authn root').to.deep.eq([]);
      expect(before.AuthnService, 'AuthnService').to.deep.eq([]);
      expect(before.MfaPolicy, 'MfaPolicy').to.deep.eq([]);
      expect(before.AuthnThrottle, 'AuthnThrottle').to.deep.eq([]);
      expect(before.CredentialExtractor, 'CredentialExtractor').to.deep.eq([]);
      expect(before.AuthnPrincipalResolver, 'AuthnPrincipalResolver').to.deep.eq([]);
      expect(before.ServerMiddleware).to.not.include('AuthnMiddleware');
      expect(before.RouteArgs, 'RouteArgs').to.deep.eq([]);
      expect(before.Controllers, 'Controllers').to.not.include.members(V3_CONTROLLERS);
      if (loadedV3Controllers !== null) expect(loadedV3Controllers, 'loaded 3.0 controller modules').to.deep.eq([]);

      expect(after.AuthnService).to.include('DefaultAuthnService');
      expect(after.MfaPolicy).to.include('DefaultMfaPolicy');
      expect(after.AuthnThrottle).to.include('MemoryAuthnThrottle');
      expect(after.CredentialExtractor).to.have.members(['HttpSignatureExtractor', 'AuthorizationBearerExtractor', 'ApiKeyHeaderExtractor']);
      expect(after.AuthnPrincipalResolver).to.have.members(['KeyPrincipalResolver', 'TokenPrincipalResolver', 'SessionPrincipalResolver']);
      expect(after.ServerMiddleware).to.include('AuthnMiddleware');
      expect(after.RouteArgs).to.deep.eq(ROUTE_ARG_NAMES);
      expect(after.Controllers, 'registerAuthnHttpV3 adds no controller: the app scans src/v3/controllers').to.not.include.members(V3_CONTROLLERS);

      expect(n10.body, 'N10: the one 401 body, from the barrel').to.deep.eq({ error: { code: 'E_AUTH_FAILED', message: 'login or password incorrect' }, message: 'login or password incorrect' });
      expect(n10.functions, 'N10: the cookie helpers, from the barrel').to.deep.eq(['authnFailureResponse', 'authnSessionCookie', 'authnClearedSessionCookie']);
    });
  }

  it('the barrel reaches no file of src/v3/controllers, so no import loads a 3.0 controller', () => {
    const graph = [...barrelGraph()].map((f) => f.replace(/\\/g, '/'));
    expect(graph.some((f) => f.endsWith('/src/v3/responses.ts')), 'the walk follows re-exports').to.eq(true);
    expect(graph.filter((f) => f.includes('/src/v3/controllers/'))).to.deep.eq([]);
    expect(graph.filter((f) => f.endsWith('/src/v3/routes.ts'))).to.deep.eq([]);
  });
});
