import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { ConversionError, DEFAULT_SELF_RESOURCES, analyze, readDbFacts, scanSources } from '../src/index.js';
import type { DbFacts, Finding } from '../src/index.js';

const SAFE_HTTP = { trustProxy: 1, cors: { origins: ['https://app'] } };
const SAFE_SESSION = { session: { cookie: { hostPrefix: false } }, password: { expiration: { enabled: false } }, twoFactorAuth: { enabled: false } };

function findings(config: Record<string, unknown>, extra: { db?: DbFacts; src?: ReturnType<typeof scanSources> } = {}): Finding[] {
  const rbac = { ...SAFE_SESSION, ...((config.rbac as object) ?? {}) };
  return analyze({ http: SAFE_HTTP, ...config, rbac }, 'common', { selfResources: DEFAULT_SELF_RESOURCES, ...extra }).list;
}

const byCode = (list: Finding[], code: string) => list.filter((x) => x.code === code);

function tmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'authz-convert-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, name, '..'), { recursive: true });
    fs.writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('analyze', () => {
  describe('grants', () => {
    it('warns when 2.x absorbed a scope token into a * from an :own grant of an extended role', () => {
      const list = findings({
        rbac: {
          grants: {
            base: { Campaign: { 'read:own': ['*'] } },
            'polsat.backoffice': { $extend: ['base'], Campaign: { 'read:own': ['scope:polsat'] } },
          },
        },
      });
      const w = byCode(list, 'absorbed-scope');
      expect(w).to.have.length(1);
      expect(w[0].message).to.match(/'scope:polsat'.*'base'/);
    });

    it('does not warn when the * comes from an :any grant, which 2.x checked first anyway', () => {
      const list = findings({ rbac: { grants: { base: { Campaign: { 'read:any': ['*'] } }, r: { $extend: ['base'], Campaign: { 'read:own': ['scope:polsat'] } } } } });
      expect(byCode(list, 'absorbed-scope')).to.deep.equal([]);
    });

    it('names roles extended but defined elsewhere, and case-only twins', () => {
      const list = findings({ rbac: { grants: { admin: { $extend: ['admin.users', 'Editor'] }, editor: {} } } });
      expect(byCode(list, 'extends-outside')[0].message).to.match(/'admin\.users'/);
      expect(byCode(list, 'role-case')[0].message).to.match(/extends 'Editor'.*'editor'/);
    });

    it('warns about resources that differ only in case and about a default role that is not defined', () => {
      const list = findings({ rbac: { defaultRole: 'User', grants: { user: { Doc: { 'read:any': ['*'] } }, admin: { doc: { 'read:any': ['*'] } } } } });
      expect(byCode(list, 'resource-case')).to.have.length(1);
      expect(byCode(list, 'default-role')[0].message).to.match(/only in case/);
    });

    it("lists the models relation 'owner' needs, checked against the sources with --src", () => {
      const grants = { r: { Note: { 'read:own': ['*'] }, Task: { 'read:own': ['*'] }, Page: { 'read:own': ['*'] }, Campaign: { 'read:own': ['scope:pool'] } } };
      expect(byCode(findings({ rbac: { grants } }), 'owner-relation').map((x) => x.severity)).to.deep.equal(['warning', 'warning', 'warning']);

      const dir = tmpDir({
        'note.ts': "@OrmResource('Note')\nexport class Note { @ResourceOwner()\n  Owner: number; }",
        'task.ts': "@OrmResource('Task')\nexport class Task {}",
        'policies.ts': "@OrmPermission(Campaign, 'pool')\nexport class P {}",
      });
      const list = findings({ rbac: { grants } }, { src: scanSources(dir) });
      const owner = byCode(list, 'owner-relation');
      expect(owner.map((x) => [x.path, x.severity])).to.deep.equal([
        ['Note', 'info'],
        ['Task', 'warning'],
        ['Page', 'warning'],
      ]);
      expect(byCode(list, 'scope-relation')[0].severity).to.equal('info');
      expect(byCode(findings({ rbac: { grants: { r: { Campaign: { 'read:own': ['scope:other'] } } } } }, { src: scanSources(dir) }), 'scope-relation')[0].severity).to.equal('warning');
    });
  });

  describe('db facts', () => {
    const grants = { user: {}, admin: {}, 'admin.users': {} };

    it('lists users who hold several roles, and those 2.x gave nothing because one role was undefined', () => {
      const db: DbFacts = {
        users: [
          { id: 'a', roles: ['user', 'admin'] },
          { id: 'b', roles: ['user', 'Stock editor'] },
          { id: 'c', roles: ['user'] },
        ],
        tokens: [],
      };
      const list = findings({ rbac: { grants, roles: [{ Name: 'Stock editor' }] } }, { db });
      expect(byCode(list, 'roles-together')[0].message).to.match(/^2 user\(s\).*a \(user, admin\); b \(user, Stock editor\)/);
      expect(byCode(list, 'roles-voided')[0].message).to.match(/^1 user\(s\).*b \(user, Stock editor\)/);
    });

    it('warns about held roles no config defines, case twins included, and tokens without expiry', () => {
      const db: DbFacts = {
        users: [{ id: 'a', roles: ['Admin'] }, { id: 'b', roles: ['ghost'] }],
        tokens: [
          { id: 't1', roles: ['user'], expiresAt: null },
          { id: 't2', roles: ['user'], expiresAt: '2027-01-01' },
        ],
      };
      const list = findings({ rbac: { grants } }, { db });
      expect(byCode(list, 'held-unknown-role').map((x) => x.message)).to.satisfy((m: string[]) => m.some((s) => /'Admin'.*'admin' only in case/.test(s)) && m.some((s) => /'ghost'/.test(s)));
      expect(byCode(list, 'token-no-expiry')[0].message).to.match(/^1 API token.*t1$/);
    });
  });

  describe('http and secrets', () => {
    it('warns about a missing trustProxy, an empty CORS list and a cookie secret written in a file', () => {
      const list = analyze({ http: { cookie: { secret: 'swqq123' }, cors: { origins: [] } }, rbac: SAFE_SESSION }, 'prod', { selfResources: DEFAULT_SELF_RESOURCES }).list;
      expect(list.map((x) => x.code)).to.deep.equal(['trust-proxy', 'cors-empty', 'cookie-secret']);
      expect(list[0].layer).to.equal('prod');
    });

    it('accepts a cookie secret loaded through a config protocol, but not a web URL', () => {
      const ok = analyze({ http: { ...SAFE_HTTP, cookie: { secret: 'env://COOKIE_SECRET' } }, rbac: SAFE_SESSION }, 'common', { selfResources: [] }).list;
      expect(ok).to.deep.equal([]);
      const url = analyze({ http: { ...SAFE_HTTP, cookie: { secret: 'https://x' } }, rbac: SAFE_SESSION }, 'common', { selfResources: [] }).list;
      expect(url.map((x) => x.code)).to.deep.equal(['cookie-secret']);
    });

    it('says the session cookie gets the __Host- name unless hostPrefix is false, and that secure: false no longer relaxes it', () => {
      const list = analyze({ http: SAFE_HTTP, rbac: { ...SAFE_SESSION, session: { cookie: { name: 'sid', secure: false } } } }, 'common', { selfResources: [] }).list;
      expect(list.map((x) => x.code)).to.deep.equal(['cookie-rename', 'cookie-secure']);
      expect(list[0].message).to.match(/'__Host-sid'/);
    });
  });
});

describe('analyze package defaults', () => {
  it('warns where the app ran with a 2.x package default that 3.0 does not keep', () => {
    const list = analyze({ http: SAFE_HTTP, rbac: { session: { cookie: { hostPrefix: false } } } }, 'common', { selfResources: [] }).list;
    expect(list.map((x) => x.code)).to.deep.equal(['password-expiry-default', 'mfa-default']);
    expect(analyze({ http: SAFE_HTTP }, 'common', { selfResources: [] }).list).to.deep.equal([]);
  });
});

describe('readDbFacts', () => {
  it('reads role lists as arrays, JSON strings or comma lists', () => {
    const dir = tmpDir({
      'db.json': JSON.stringify({
        users: [
          { Login: 'a', Role: ['admin', 'user'] },
          { Id: 7, Role: '["user"]' },
          { Uuid: 'u', Role: 'user, admin' },
          { Role: null },
        ],
        tokens: [{ Id: 1, Roles: 'user', ExpiresAt: null }],
      }),
    });
    const db = readDbFacts(join(dir, 'db.json'));
    expect(db.users).to.deep.equal([
      { id: 'a', roles: ['admin', 'user'] },
      { id: '7', roles: ['user'] },
      { id: 'u', roles: ['user', 'admin'] },
      { id: '#3', roles: [] },
    ]);
    expect(db.tokens).to.deep.equal([{ id: '1', roles: ['user'], expiresAt: null }]);
  });

  it('refuses a file of the wrong shape', () => {
    const dir = tmpDir({ 'a.json': '[]', 'b.json': '{ "users": {} }', 'c.json': '{ "users": [{ "Role": 5 }] }', 'd.json': 'nope' });
    for (const f of ['a.json', 'b.json', 'c.json', 'd.json']) expect(() => readDbFacts(join(dir, f))).to.throw(ConversionError);
  });
});
