import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
}

// Plain JS for the ESM and the CJS child: the built package, loaded as an app loads it.
const ROUTE_ARG_NAMES = ['AuthnIdentityArg', 'AuthnSessionArg', 'AuthnSessionIdArg', 'AuthnSessionDataArg'];

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
  });
  const before = snap(di, http, contracts, pkg);
  await pkg.registerAuthnHttpV3();
  console.log(JSON.stringify({ before, after: snap(di, http, contracts, pkg) }));
`;

const ESM = `
  const di = await import('@spinajs/di');
  const http = await import('@spinajs/http');
  const contracts = await import('@spinajs/authn/contracts');
  const pkg = await import('@spinajs/authn-http');
  ${BODY}
`;

const CJS = `
  (async () => {
    const di = require('@spinajs/di');
    const http = require('@spinajs/http');
    const contracts = require('@spinajs/authn/contracts');
    const pkg = require('@spinajs/authn-http');
    ${BODY}
  })().catch((e) => { console.error(e); process.exit(1); });
`;

function run(inputType: 'module' | 'commonjs', body: string): { before: Snapshot; after: Snapshot } {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

describe('the 3.0 authn layer ships switched off (N8c)', function () {
  this.timeout(120000);

  for (const [label, inputType, body] of [
    ['ESM', 'module', ESM],
    ['CJS', 'commonjs', CJS],
  ] as const) {
    it(`${label}: importing the package registers no authn service, extractor, resolver, route arg or AuthnMiddleware; registerAuthnHttpV3 does`, () => {
      const { before, after } = run(inputType, body);
      expect(before.AuthnService, 'AuthnService').to.deep.eq([]);
      expect(before.MfaPolicy, 'MfaPolicy').to.deep.eq([]);
      expect(before.AuthnThrottle, 'AuthnThrottle').to.deep.eq([]);
      expect(before.CredentialExtractor, 'CredentialExtractor').to.deep.eq([]);
      expect(before.AuthnPrincipalResolver, 'AuthnPrincipalResolver').to.deep.eq([]);
      expect(before.ServerMiddleware).to.not.include('AuthnMiddleware');
      expect(before.RouteArgs, 'RouteArgs').to.deep.eq([]);

      expect(after.AuthnService).to.include('DefaultAuthnService');
      expect(after.MfaPolicy).to.include('DefaultMfaPolicy');
      expect(after.AuthnThrottle).to.include('MemoryAuthnThrottle');
      expect(after.CredentialExtractor).to.have.members(['HttpSignatureExtractor', 'AuthorizationBearerExtractor', 'ApiKeyHeaderExtractor']);
      expect(after.AuthnPrincipalResolver).to.have.members(['KeyPrincipalResolver', 'TokenPrincipalResolver', 'SessionPrincipalResolver']);
      expect(after.ServerMiddleware).to.include('AuthnMiddleware');
      expect(after.RouteArgs).to.deep.eq(ROUTE_ARG_NAMES);
    });
  }
});
