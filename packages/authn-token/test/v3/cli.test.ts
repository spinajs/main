import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHash, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { OrmException } from '@spinajs/orm';
import { AuthnEventSink, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore, RecordingEventSink } from '@spinajs/authn-testing';
import { DateTime } from 'luxon';

import '../../src/generator.js';
import { AccessToken } from '../../src/models/AccessToken.js';
import { DbTokenService, NoTokenProfilesPolicy, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { CreateToken } from '../../src/cli/CreateToken.js';
import { DeleteToken } from '../../src/cli/DeleteToken.js';
import { DeleteExpiredTokens } from '../../src/cli/DeleteExpiredTokens.js';
import { TokenCliCommand } from '../../src/cli/TokenCliCommand.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';

const TABLE = 'rbac_access_tokens';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;
const PLAINTEXT = /spt_[A-Za-z0-9_-]{43}/;
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security', 'success'] as const;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ctx = (now: Date): AuthnContext => ({ now, purpose: 'request' });

class CliTestSink extends RecordingEventSink {}
class CliTestProfilePolicy extends TokenProfilePolicy {
  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return ['reports'];
  }
}

/**
 * Registered as the TokenService instead of registering an IdentityStore: unregistering a store
 * leaves an empty IdentityStore registration, which later suites resolve to nothing.
 */
class CliTestTokenService extends DbTokenService {
  public static profiles: TokenProfilePolicy = new NoTokenProfilesPolicy();

  constructor() {
    super(new UsersTableTokenOwnerResolver(), CliTestTokenService.profiles, new FakeIdentityStore());
  }
}

interface Output {
  /** Lines the command wrote to stdout. */
  readonly out: string[];
  /** Messages its logger received, at any level; the service logs to the same named logger. */
  readonly logs: string[];
  readonly all: string[];
}

const captureBox = sinon.createSandbox();

function capture(cmd: object): () => Output {
  const log = (cmd as { Log: Record<(typeof LEVELS)[number], (...args: unknown[]) => void> }).Log;
  // The commands share one logger, so the previous command run of this test is unwrapped first.
  captureBox.restore();
  const spies = LEVELS.map((level) => captureBox.spy(log, level));
  const out: string[] = [];
  if (typeof (cmd as { write?: unknown }).write === 'function') {
    captureBox.stub(cmd as { write(line: string): void }, 'write').callsFake((line: string) => void out.push(line));
  }
  return () => {
    const logs = spies.flatMap((s) => s.getCalls().map((c) => c.args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
    return { out: [...out], logs, all: [...out, ...logs] };
  };
}

type Ok = Extract<TokenCreateResult, { ok: true }>;

describe('token cli commands', function () {
  this.timeout(15000);

  let sink: CliTestSink;
  let savedDefaultTtl: unknown;
  let savedExitCode: typeof process.exitCode;
  const config = () => DI.get(Configuration)!;

  function uncacheService(): void {
    DI.uncache(TokenService);
    DI.uncache(CliTestTokenService);
  }

  before(async () => {
    await bootV3Db();
    DI.register(CliTestTokenService).as(TokenService);
    DI.register(CliTestSink).as(AuthnEventSink);
    savedDefaultTtl = config().get('authn.token.defaultTtlDays');
  });

  after(async () => {
    DI.unregister(CliTestTokenService);
    DI.unregister(CliTestSink);
    DI.uncache(CliTestSink);
    DI.uncache(Array.ofType(AuthnEventSink));
    uncacheService();
    DI.uncache(CreateToken);
    DI.uncache(DeleteToken);
    DI.uncache(DeleteExpiredTokens);
    await shutdownV3Db();
  });

  beforeEach(async () => {
    await v3Connection().del().from(TABLE);
    sink = DI.resolve(Array.ofType(AuthnEventSink)).find((s) => s instanceof CliTestSink) as CliTestSink;
    sink.clear();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    captureBox.restore();
    sinon.restore();
    config().set('authn.token.defaultTtlDays', savedDefaultTtl);
  });

  async function owner(): Promise<{ ref: IdentityRef; rowId: number }> {
    const uuid = randomUUID();
    return { ref: { type: 'user', id: uuid }, rowId: await insertUserRow(uuid) };
  }

  async function service(): Promise<DbTokenService> {
    return (await DI.resolve(TokenService)) as DbTokenService;
  }

  async function mint(o: IdentityRef, now = new Date()): Promise<Ok> {
    const r = await (await service()).create(o, { name: 'minted', kind: 'pat', expiresAt: new Date(now.getTime() + DAY) }, ctx(now));
    if (!r.ok) {
      throw new Error(`not minted: ${JSON.stringify(r)}`);
    }
    return r;
  }

  async function rows(): Promise<AccessToken[]> {
    return AccessToken.all();
  }

  async function row(uuid: string): Promise<AccessToken | undefined> {
    return AccessToken.where('Uuid', uuid).first();
  }

  /** A row written straight through the model, as a 2.x install or another process would. */
  async function stored(rowId: number, name: string, fields: Partial<AccessToken>): Promise<AccessToken> {
    const t = new AccessToken({ Name: name, Token: sha256(randomUUID()), Roles: [], Kind: 'pat', CreatedAt: DateTime.now() as DateTime<true>, user_id: rowId, ...fields });
    await t.insert();
    return t;
  }

  it('every command extends TokenCliCommand', () => {
    for (const cmd of [CreateToken, DeleteToken, DeleteExpiredTokens]) {
      expect(cmd.prototype, cmd.name).to.be.instanceOf(TokenCliCommand);
    }
  });

  describe('authn:token-create', () => {
    async function create(ownerUuid: string, options: Record<string, unknown>): Promise<Output> {
      const cmd = await DI.resolve(CreateToken);
      const output = capture(cmd);
      await cmd.execute(ownerUuid, options as never);
      return output();
    }

    async function refusedWith(ownerUuid: string, options: Record<string, unknown>, code: string): Promise<void> {
      const output = await create(ownerUuid, options);
      const label = JSON.stringify(options);
      expect(
        output.all.some((m) => m.includes(code)),
        `${label}: prints ${code} in ${JSON.stringify(output)}`,
      ).to.equal(true);
      expect(
        output.all.some((m) => PLAINTEXT.test(m)),
        `${label}: no plaintext`,
      ).to.equal(false);
      expect(await rows(), `${label}: nothing stored`).to.have.length(0);
      expect(process.exitCode, `${label}: exit code`).to.equal(1);
      process.exitCode = undefined;
    }

    it('writes the id, the expiry and the plaintext once to stdout, never to the logger, and never the hash', async () => {
      const a = await owner();
      const expires = DateTime.now().plus({ days: 2 }).toUTC().toISO()!;

      const { out, logs, all } = await create(a.ref.id, { name: 'ci', roles: 'user, editor', expires });

      const [token] = await rows();
      expect(token.Name).to.equal('ci');
      expect(token.Kind).to.equal('pat');
      expect(token.Roles).to.deep.equal(['user', 'editor']);
      expect(token.user_id).to.equal(a.rowId);

      const plaintexts = out.flatMap((m) => m.match(new RegExp(PLAINTEXT.source, 'g')) ?? []);
      expect(plaintexts, JSON.stringify(out)).to.have.length(1);
      expect(sha256(plaintexts[0])).to.equal(token.Token);
      expect(
        out.filter((m) => m.includes(plaintexts[0])),
        'the plaintext stands on its own line',
      ).to.deep.equal([plaintexts[0]]);
      expect(out.some((m) => /copy the token now, it will not be shown again/i.test(m))).to.equal(true);
      expect(out.some((m) => m.includes(token.Uuid))).to.equal(true);
      expect(out.some((m) => m.includes(token.ExpiresAt!.toUTC().toISO()!) || m.includes(token.ExpiresAt!.toJSDate().toISOString()))).to.equal(true);

      expect(
        logs.some((m) => m.includes(plaintexts[0]) || PLAINTEXT.test(m)),
        `the plaintext is logged: ${JSON.stringify(logs)}`,
      ).to.equal(false);
      expect(
        logs.some((m) => m.includes(token.Uuid) && m.includes(a.ref.id)),
        `no audit line: ${JSON.stringify(logs)}`,
      ).to.equal(true);
      expect(
        all.some((m) => m.includes(token.Token)),
        'the hash is printed',
      ).to.equal(false);
      expect(process.exitCode).to.equal(undefined);
    });

    it('prints neither the hash nor the plaintext when storing the token fails', async () => {
      const a = await owner();
      // As orm-sqlite and mysql word a failed insert: the query bindings, or the duplicate value, in the message.
      const failures: Array<(t: AccessToken) => Error> = [(t) => new OrmException(`Failed to execute query: INSERT INTO rbac_access_tokens, bindings: ${t.Token},${t.Name}`), (t) => Object.assign(new Error(`Duplicate entry '${t.Token}' for key 'Token'`), { code: 'ER_DUP_ENTRY' })];

      for (const failure of failures) {
        let hash = '';
        const insert = sinon.stub(AccessToken.prototype, 'insert').callsFake(function (this: AccessToken) {
          hash = this.Token;
          return Promise.reject(failure(this));
        });

        const { all } = await create(a.ref.id, { name: 'unstored' });
        insert.restore();

        expect(hash, 'the insert ran').to.not.equal('');
        expect(
          all.some((m) => m.includes(hash)),
          `the hash is printed: ${JSON.stringify(all)}`,
        ).to.equal(false);
        expect(
          all.some((m) => PLAINTEXT.test(m)),
          `the plaintext is printed: ${JSON.stringify(all)}`,
        ).to.equal(false);
        expect(
          all.some((m) => /Error while creating token/.test(m)),
          JSON.stringify(all),
        ).to.equal(true);
        expect(process.exitCode).to.equal(1);
        process.exitCode = undefined;
      }
      expect(await rows()).to.have.length(0);
    });

    // LEDGER cli row 2
    it('honours --expires', async () => {
      const a = await owner();
      const iso = DateTime.now().plus({ days: 1 }).toISO()!;

      await create(a.ref.id, { name: 'expiring', roles: 'user', expires: iso });

      const [token] = await rows();
      expect(token.ExpiresAt!.toMillis()).to.equal(DateTime.fromISO(iso).toMillis());
    });

    // LEDGER cli row 1 (rewrite, row 52): no --expires means the default TTL, never an infinite token
    it('applies authn.token.defaultTtlDays from now when --expires is not given', async () => {
      const a = await owner();

      for (const [days, label] of [
        [undefined, 'shipped default of 30 days'],
        [7, 'configured 7 days'],
      ] as const) {
        await v3Connection().del().from(TABLE);
        if (days !== undefined) {
          config().set('authn.token.defaultTtlDays', days);
        }
        const before = Date.now();
        await create(a.ref.id, { name: 'default ttl', roles: 'user' });
        const after = Date.now();

        const [token] = await rows();
        expect(token, label).to.not.equal(undefined);
        const expiresAt = token.ExpiresAt!.toMillis();
        expect(expiresAt, label).to.be.within(before + (days ?? 30) * DAY, after + (days ?? 30) * DAY);
      }
    });

    // LEDGER cli row 3
    it('refuses an unparseable --expires without creating anything', async () => {
      const a = await owner();
      await refusedWith(a.ref.id, { name: 'bad date', roles: 'user', expires: 'not-a-date' }, 'invalid_expiry');
    });

    // LEDGER cli row 4
    it('refuses an empty --expires instead of applying the default', async () => {
      const a = await owner();
      await refusedWith(a.ref.id, { name: 'empty date', roles: 'user', expires: '' }, 'invalid_expiry');
    });

    it('prints the service refusal for an expiry in the past or beyond authn.token.maxTtlDays', async () => {
      const a = await owner();
      await refusedWith(a.ref.id, { name: 'past', expires: DateTime.now().minus({ minutes: 1 }).toISO()! }, 'invalid_expiry');
      await refusedWith(a.ref.id, { name: 'too long', expires: DateTime.now().plus({ days: 91 }).toISO()! }, 'invalid_expiry');
    });

    it('refuses a default TTL above authn.token.maxTtlDays', async () => {
      const a = await owner();
      config().set('authn.token.defaultTtlDays', 365);
      await refusedWith(a.ref.id, { name: 'default too long' }, 'invalid_expiry');
    });

    it('mints pat by default and service on request', async () => {
      const a = await owner();

      await create(a.ref.id, { name: 'personal' });
      await create(a.ref.id, { name: 'machine', kind: 'service' });

      const byName = Object.fromEntries((await rows()).map((t) => [t.Name, t.Kind]));
      expect(byName).to.deep.equal({ personal: 'pat', machine: 'service' });
    });

    it('never mints an agent token or an unknown kind', async () => {
      const a = await owner();
      await refusedWith(a.ref.id, { name: 'agent', kind: 'agent' }, 'invalid_scope');
      await refusedWith(a.ref.id, { name: 'root', kind: 'root' }, 'invalid_scope');
    });

    it('stores no role ceiling without --roles and refuses a --roles that names no role', async () => {
      const a = await owner();

      await create(a.ref.id, { name: 'no ceiling' });
      const [token] = await rows();
      const record = (await (await service()).list(a.ref)).find((r) => r.id === token.Uuid)!;
      expect(record.roles).to.equal(undefined);

      await v3Connection().del().from(TABLE);
      await refusedWith(a.ref.id, { name: 'empty roles', roles: ' , ' }, 'invalid_scope');
    });

    describe('--profile', () => {
      afterEach(() => {
        CliTestTokenService.profiles = new NoTokenProfilesPolicy();
        uncacheService();
      });

      it('is refused when the profile policy does not allow it', async () => {
        const a = await owner();
        await refusedWith(a.ref.id, { name: 'pinned', profile: 'reports' }, 'invalid_scope');
      });

      it('pins the token when the profile policy allows it', async () => {
        CliTestTokenService.profiles = new CliTestProfilePolicy();
        uncacheService();
        const a = await owner();

        await create(a.ref.id, { name: 'pinned', profile: 'reports' });

        const [token] = await rows();
        expect(token.Profile).to.equal('reports');
      });
    });

    it('prints an error for an unknown owner and creates nothing', async () => {
      const output = await create(randomUUID(), { name: 'orphan' });
      expect(
        output.all.some((m) => /unknown/i.test(m)),
        JSON.stringify(output),
      ).to.equal(true);
      expect(await rows()).to.have.length(0);
      expect(process.exitCode).to.equal(1);
    });

    it('prints an error for an empty name and creates nothing', async () => {
      const a = await owner();
      const output = await create(a.ref.id, { name: '   ' });
      expect(
        output.all.some((m) => /name/.test(m)),
        JSON.stringify(output),
      ).to.equal(true);
      expect(await rows()).to.have.length(0);
      expect(process.exitCode).to.equal(1);
    });
  });

  describe('authn:token-delete', () => {
    async function remove(uuid: string, arrange?: () => void): Promise<string[]> {
      const cmd = await DI.resolve(DeleteToken);
      const output = capture(cmd);
      arrange?.();
      await cmd.execute(uuid);
      return output().all;
    }

    // LEDGER cli row 5
    it('revokes the token whoever owns it and publishes token.revoke for the owner, with the cli as actor', async () => {
      const a = await owner();
      const t = await mint(a.ref);

      const before = Date.now();
      const output = await remove(t.record.id);

      const revokedAt = (await row(t.record.id))!.RevokedAt!.toMillis();
      expect(revokedAt).to.be.within(before, Date.now());
      expect(
        output.some((m) => m.includes(t.record.id) && /revoked/.test(m) && !/not found/.test(m)),
        JSON.stringify(output),
      ).to.equal(true);
      expect(sink.ofType('token.revoke').map((e) => [e.identity, e.actor, e.data])).to.deep.equal([[a.ref, { type: 'system', id: 'cli' }, { token: t.record.id, kind: 'pat' }]]);
      expect(process.exitCode).to.equal(undefined);

      const validation = await (await service()).validate(t.plaintext, ctx(new Date()));
      expect(validation).to.deep.equal({ ok: false, reason: 'revoked' });
    });

    // LEDGER cli row 6
    it('reports an unknown or already revoked token instead of rejecting', async () => {
      const a = await owner();
      const t = await mint(a.ref);
      await remove(t.record.id);
      sink.clear();

      for (const uuid of ['not-a-uuid', randomUUID(), t.record.id]) {
        const output = await remove(uuid);
        expect(
          output.some((m) => /not found or already revoked/.test(m)),
          `${uuid}: ${JSON.stringify(output)}`,
        ).to.equal(true);
      }
      expect(sink.all()).to.deep.equal([]);
      expect(process.exitCode, 'nothing left to revoke is not a failure').to.equal(undefined);
    });

    it('exits with 1 when the revocation fails', async () => {
      const id = randomUUID();
      const output = await remove(id, () => {
        sinon.stub(DbTokenService.prototype, 'revokeById').rejects(new Error('connection lost'));
      });

      expect(
        output.some((m) => m.includes(id) && /Error while revoking/.test(m)),
        JSON.stringify(output),
      ).to.equal(true);
      expect(process.exitCode).to.equal(1);
    });
  });

  describe('authn:token-delete-expired', () => {
    // LEDGER cli row 9
    it('removes only expired and revoked tokens and prints the count', async () => {
      const a = await owner();
      const live = await mint(a.ref);
      const future = await stored(a.rowId, 'future', { ExpiresAt: DateTime.now().plus({ days: 30 }) as DateTime<true> });
      const legacy = await stored(a.rowId, 'legacy', {});
      const dead = await stored(a.rowId, 'dead', { ExpiresAt: DateTime.now().minus({ minutes: 1 }) as DateTime<true> });
      const revoked = await mint(a.ref);
      await (await service()).revoke(a.ref, revoked.record.id, ctx(new Date()));

      const cmd = await DI.resolve(DeleteExpiredTokens);
      const output = capture(cmd);
      await cmd.execute();

      expect((await rows()).map((t) => t.Uuid)).to.have.members([live.record.id, future.Uuid, legacy.Uuid]);
      expect(await row(dead.Uuid)).to.equal(undefined);
      expect(output().all).to.include('Deleted 2 expired or revoked token(s)');
      expect(process.exitCode).to.equal(undefined);
    });

    it('exits with 1 when the sweep fails', async () => {
      const cmd = await DI.resolve(DeleteExpiredTokens);
      const output = capture(cmd);
      sinon.stub(DbTokenService.prototype, 'deleteExpired').rejects(new Error('connection lost'));

      await cmd.execute();

      expect(
        output().all.some((m) => /Error while deleting expired tokens/.test(m)),
        JSON.stringify(output()),
      ).to.equal(true);
      expect(process.exitCode).to.equal(1);
    });
  });

  describe('DbTokenService.revokeById', () => {
    it('revokes once, stamps RevokedAt from ctx.now and publishes token.revoke with the owner and actor', async () => {
      const a = await owner();
      const t = await mint(a.ref);
      const now = new Date(Date.now() + MINUTE);
      const actor = { type: 'user', id: 'operator' };
      const tokens = await service();
      sink.clear();

      expect(await tokens.revokeById(t.record.id, ctx(now), { actor })).to.equal(true);
      expect((await row(t.record.id))!.RevokedAt!.toMillis()).to.equal(now.getTime());
      expect(sink.ofType('token.revoke').map((e) => [e.identity, e.actor, e.data, e.at])).to.deep.equal([[a.ref, actor, { token: t.record.id, kind: 'pat' }, now]]);

      expect(await tokens.revokeById(t.record.id, ctx(now))).to.equal(false);
      expect(sink.all()).to.have.length(1);
    });

    it('still revokes when the owner row is gone or its lookup fails, and publishes without an identity', async () => {
      const a = await owner();
      const actor = { type: 'system', id: 'cli' };
      const tokens = await service();

      for (const [label, refOf] of [
        ['owner row gone', () => Promise.resolve(null)],
        ['lookup fails', () => Promise.reject(new Error('users table unreachable'))],
      ] as const) {
        const t = await mint(a.ref);
        sink.clear();
        const lookup = sinon.stub(UsersTableTokenOwnerResolver.prototype, 'refOf').callsFake(refOf);
        const now = new Date();

        expect(await tokens.revokeById(t.record.id, ctx(now), { actor }), label).to.equal(true);
        lookup.restore();

        expect((await row(t.record.id))!.RevokedAt!.toMillis(), label).to.equal(now.getTime());
        const events = sink.ofType('token.revoke');
        expect(
          events.map((e) => [e.actor, e.data]),
          label,
        ).to.deep.equal([[actor, { token: t.record.id, kind: 'pat' }]]);
        expect(events[0], label).to.not.have.property('identity');
      }
    });

    it('answers false for an empty, unknown or non-string id', async () => {
      const tokens = await service();
      for (const id of ['', randomUUID(), 7, null]) {
        expect(await tokens.revokeById(id as string, ctx(new Date())), String(id)).to.equal(false);
      }
      expect(sink.all()).to.deep.equal([]);
    });
  });

  // LEDGER actions-validate row 11
  describe('DbTokenService.deleteExpired', () => {
    const NOW = DateTime.fromISO('2026-10-03T10:00:00.000Z') as DateTime<true>;

    it('deletes rows expired at or before now and revoked rows, keeps live and null-expiry rows', async () => {
      const a = await owner();
      const atNow = await stored(a.rowId, 'at now', { ExpiresAt: NOW });
      const before = await stored(a.rowId, 'before', { ExpiresAt: NOW.minus({ days: 1 }) });
      const after = await stored(a.rowId, 'after', { ExpiresAt: NOW.plus({ milliseconds: 1 }) });
      const revoked = await stored(a.rowId, 'revoked', { ExpiresAt: NOW.plus({ days: 1 }), RevokedAt: NOW.minus({ hours: 1 }) });
      const revokedLegacy = await stored(a.rowId, 'revoked legacy', { RevokedAt: NOW.minus({ hours: 1 }) });
      const legacy = await stored(a.rowId, 'legacy', {});

      expect(await (await service()).deleteExpired(NOW.toJSDate())).to.equal(4);

      const left = (await rows()).map((t) => t.Uuid);
      expect(left).to.have.members([after.Uuid, legacy.Uuid]);
      for (const gone of [atNow, before, revoked, revokedLegacy]) {
        expect(left, gone.Name).to.not.include(gone.Uuid);
      }
    });

    it('compares against the given now, not the clock of the database', async () => {
      const a = await owner();
      const wallClockExpired = await stored(a.rowId, 'expired by the wall clock', { ExpiresAt: DateTime.now().minus({ days: 1 }) as DateTime<true> });

      expect(await (await service()).deleteExpired(DateTime.now().minus({ days: 2 }).toJSDate())).to.equal(0);
      expect(await row(wallClockExpired.Uuid)).to.not.equal(undefined);

      expect(await (await service()).deleteExpired(DateTime.now().plus({ days: 400 }).toJSDate())).to.equal(1);
    });

    it('deletes an expired row whose other columns no longer read back', async () => {
      const a = await owner();
      const broken = await stored(a.rowId, 'broken scope', { ExpiresAt: NOW.minus({ days: 1 }) });
      await v3Connection().update().in(TABLE).update({ Scope: '{not json' }).where({ Uuid: broken.Uuid });

      expect(await (await service()).deleteExpired(NOW.toJSDate())).to.equal(1);
      expect(await v3Connection().select().from(TABLE).where({ Uuid: broken.Uuid })).to.have.length(0);
    });

    it('refuses a now that is not a valid Date', async () => {
      const tokens = await service();
      for (const now of [new Date(Number.NaN), undefined, '2026-10-03T10:00:00Z']) {
        const err = await tokens.deleteExpired(now as Date).catch((e: unknown) => e);
        expect(err, String(now)).to.be.instanceOf(Error);
      }
    });
  });
});
