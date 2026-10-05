import 'mocha';
import { expect } from 'chai';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = join(PKG_ROOT, 'test', 'v3', 'route-groups-app.cjs');

type Group = 'password' | 'mfa' | 'tokens' | 'keys';
type Package = 'local' | 'totp' | 'token' | 'keys';

/** Design §22.11: each N8b route group and the strategy package whose service switches it on. */
const PACKAGE_OF: Record<Group, Package> = { password: 'local', mfa: 'totp', tokens: 'token', keys: 'keys' };
const GROUPS = Object.keys(PACKAGE_OF) as Group[];
const ALL: Package[] = ['local', 'totp', 'token', 'keys'];

interface Answer {
  group: Group;
  status: number;
  error: string | null;
}

interface Boot {
  mode: 'esm' | 'cjs';
  packages: Package[];
  usersModules: string[];
  bootstrappers: string[];
  sessionProviders: string[];
  registered: Record<'PasswordService' | 'TotpService' | 'TokenService' | 'KeyRegistry', boolean>;
  routes: string[];
  controllers: string[];
  anonymous: Record<string, Answer>;
  login: number;
  whoami: number;
  session: Record<string, Answer>;
  touched: { attempts: string[]; succeeds: string[]; events: string[] };
  control: { status: number; error: string | null; attempts: string[]; events: string[] } | null;
}

/** What an anonymous caller hears from an open group: the route's own policies and field checks, never the gate. */
const OPEN: Record<string, Omit<Answer, 'group'>> = {
  'GET /auth/password/policy': { status: 200, error: null },
  'POST /auth/password/reset-request': { status: 400, error: 'invalid_login' },
  'POST /auth/password/reset': { status: 401, error: 'E_AUTH_FAILED' },
  'PATCH /user/password': { status: 401, error: 'unauthenticated' },
  'GET /user/mfa': { status: 401, error: 'unauthenticated' },
  'POST /user/mfa': { status: 401, error: 'unauthenticated' },
  'POST /user/mfa/confirm': { status: 401, error: 'unauthenticated' },
  'POST /user/mfa/disable': { status: 401, error: 'unauthenticated' },
  'POST /user/mfa/recovery-codes': { status: 401, error: 'unauthenticated' },
  'GET /user/tokens': { status: 401, error: 'unauthenticated' },
  'POST /user/tokens': { status: 401, error: 'unauthenticated' },
  'DELETE /user/tokens/00000000-0000-4000-8000-000000000000': { status: 401, error: 'unauthenticated' },
  'GET /user/keys': { status: 401, error: 'unauthenticated' },
  'POST /user/keys': { status: 401, error: 'unauthenticated' },
  'DELETE /user/keys/some-kid': { status: 401, error: 'unauthenticated' },
  'POST /auth/keys/challenge': { status: 401, error: 'unauthenticated' },
  'POST /auth/keys/login': { status: 401, error: 'E_AUTH_FAILED' },
};

/** The routes N8b mounts (password 4, MFA 5, tokens 3, keys 5), as express lists them. */
const N8B_ROUTES: Record<Group, string[]> = {
  password: ['GET /auth/password/policy', 'POST /auth/password/reset-request', 'POST /auth/password/reset', 'PATCH /user/password'],
  mfa: ['GET /user/mfa', 'POST /user/mfa', 'POST /user/mfa/confirm', 'POST /user/mfa/disable', 'POST /user/mfa/recovery-codes'],
  tokens: ['GET /user/tokens', 'POST /user/tokens', 'DELETE /user/tokens/:uuid'],
  keys: ['GET /user/keys', 'POST /user/keys', 'DELETE /user/keys/:kid', 'POST /auth/keys/challenge', 'POST /auth/keys/login'],
};

const V3_CONTROLLERS = ['AuthnActiveRoleController', 'AuthnImpersonationController', 'AuthnKeysController', 'AuthnLoginController', 'AuthnMfaController', 'AuthnMfaEnrolmentController', 'AuthnPasswordController', 'AuthnSessionsController', 'AuthnTokensController'];

interface Case {
  mode: 'esm' | 'cjs';
  packages: Package[];
}

// Every package is absent and present at least once; the CJS pair checks the build's subpaths, authn-totp's
// ./service among them.
const CASES: Case[] = [
  { mode: 'esm', packages: [] },
  { mode: 'esm', packages: ['local'] },
  { mode: 'esm', packages: ['totp'] },
  { mode: 'esm', packages: ['token'] },
  { mode: 'esm', packages: ['keys'] },
  { mode: 'esm', packages: ALL },
  { mode: 'cjs', packages: [] },
  { mode: 'cjs', packages: ALL },
];

const label = (c: Case) => `${c.mode.toUpperCase()} ${c.packages.length === 0 ? 'no strategy package' : c.packages.length === ALL.length ? 'every strategy package' : c.packages.join(', ')}`;
const isOn = (c: Case, g: Group) => c.packages.includes(PACKAGE_OF[g]);

const children: ChildProcess[] = [];

function boot(c: Case): Promise<Boot> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const off = GROUPS.filter((g) => !isOn(c, g));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CHILD, c.mode, c.packages.join(','), off.join(',')], { cwd: PKG_ROOT, env, timeout: 150000, killSignal: 'SIGKILL' });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (code !== 0) return fail(new Error(`${label(c)}: ${signal ? `killed by ${signal}` : `exit ${code}`}\n${err}`));
      const lines = out.trim().split(/\r?\n/);
      try {
        done(JSON.parse(lines[lines.length - 1]) as Boot);
      } catch (e) {
        fail(new Error(`${label(c)}: no JSON result (${(e as Error).message})\n${out}\n${err}`));
      }
    });
  });
}

describe('each 3.0 route group only with its service (N8b task 6, design §22.11)', function () {
  this.timeout(240000);

  const boots = new Map<Case, Boot>();

  before(async () => {
    const results = await Promise.all(CASES.map((c) => boot(c)));
    CASES.forEach((c, i) => boots.set(c, results[i]));
  });

  after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  for (const c of CASES) {
    describe(label(c), () => {
      it('boots the 3.0 controllers with no users bootstrapper and one session provider, with the packages named and no other', () => {
        const b = boots.get(c)!;
        expect(b.usersModules, 'CJS only: loaded modules of @spinajs/users').to.deep.eq([]);
        expect(b.bootstrappers).to.not.include('RbacBootstrapper');
        expect(b.sessionProviders).to.deep.eq(['MemorySessionStore']);
        expect([...b.controllers].sort()).to.deep.eq(V3_CONTROLLERS);
        expect(b.registered).to.deep.eq({ PasswordService: isOn(c, 'password'), TotpService: isOn(c, 'mfa'), TokenService: isOn(c, 'tokens'), KeyRegistry: isOn(c, 'keys') });
      });

      it('an anonymous call gets 404 not_found from every route of a group that is off, before any authentication policy, and the route answer of every group that is on', () => {
        const b = boots.get(c)!;
        expect(Object.keys(b.anonymous)).to.have.members(Object.keys(OPEN));
        for (const [route, answer] of Object.entries(b.anonymous)) {
          const expected = isOn(c, answer.group) ? OPEN[route] : { status: 404, error: 'not_found' };
          expect({ status: answer.status, error: answer.error }, `${route} (${answer.group} ${isOn(c, answer.group) ? 'on' : 'off'})`).to.deep.eq(expected);
        }
      });

      it('a stale session sending reauthPassword, an old password or a code gets 404 not_found from every route of a group that is off, which neither re-authenticates nor touches a throttle', () => {
        const b = boots.get(c)!;
        expect([b.login, b.whoami], 'login, then the session works').to.deep.eq([200, 200]);
        const off = GROUPS.filter((g) => !isOn(c, g));
        expect([...new Set(Object.values(b.session).map((a) => a.group))].sort()).to.deep.eq([...off].sort());
        for (const [route, answer] of Object.entries(b.session)) expect({ status: answer.status, error: answer.error }, route).to.deep.eq({ status: 404, error: 'not_found' });
        expect(b.touched).to.deep.eq({ attempts: [], succeeds: [], events: [] });
      });

      if (isOn(c, 'tokens')) {
        it('the same probe sees a re-authentication where a route runs one: an open POST /user/tokens verifies reauthPassword', () => {
          expect(boots.get(c)!.control).to.deep.eq({ status: 400, error: 'invalid_name', attempts: ['reauth'], events: ['reauth/success'] });
        });
      }
    });
  }

  describe('lane route table', () => {
    it('with every strategy package loaded each N8b route is mounted exactly once and no method and path twice across the N8a and N8b controllers', () => {
      for (const c of CASES.filter((x) => x.packages.length === ALL.length)) {
        const { routes } = boots.get(c)!;
        const shapes = routes.map((r) => r.replace(/:w+/g, ':param'));
        for (const route of GROUPS.flatMap((g) => N8B_ROUTES[g]))
          expect(
            routes.filter((r) => r === route),
            `${label(c)}: ${route}`,
          ).to.have.length(1);
        expect(
          shapes.filter((r, i) => shapes.indexOf(r) !== i),
          label(c),
        ).to.deep.eq([]);
      }
    });

    it('the route table does not depend on the packages: a controller scan mounts every group, the gates switch them', () => {
      const tables = CASES.map((c) => [...boots.get(c)!.routes].sort());
      for (const t of tables) expect(t).to.deep.eq(tables[0]);
    });
  });
});
