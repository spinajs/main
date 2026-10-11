/** Compiles the claim, compare-and-set and purge queries of the task 3 stores for MySQL and MSSQL: no server needed. */
import { FakeClock } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { ResourceDuplicated, UnexpectedServerError } from '@spinajs/exceptions';
import '@spinajs/log';
import { OrmException, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { createHash } from 'node:crypto';

import { DbIdentityLinkStore, DbMfaStore, DbNonceStore, DbSecretStore } from '../src/index.js';
import { FakeMsSql, FakeMySql, fake, sql } from './support/fake-drivers.js';

const ALICE: IdentityRef = { type: 'user', id: '0b6a3c1e-8a55-4c41-9f0e-4b1d2a7c9e10' };
const NOW = new Date('2026-06-01T10:00:00.000Z');
const NOW_TEXT = '2026-06-01 10:00:00.000';
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const DIALECTS = [
  {
    name: 'mysql',
    type: FakeMySql,
    duplicate: () => new OrmException('Error executing orm command ', { Name: 'mysql' }, 'INSERT', [], Object.assign(new Error("Duplicate entry 'x' for key 'PRIMARY'"), { code: 'ER_DUP_ENTRY', errno: 1062 })),
    secretSelect: 'SELECT `id`,`identity`,`purpose`,CAST(expires_at AS CHAR) AS expires_text FROM `authn_secret` WHERE `secret_hash` = ? AND `identity` = ? AND `purpose` = ? AND `used_at` IS NULL',
    secretClaim: 'UPDATE `authn_secret` SET `used_at` = ? WHERE `id` = ? AND `used_at` IS NULL AND `expires_at` > ?',
    secretPurge: 'SELECT `id` FROM `authn_secret` WHERE ( `used_at` IS NOT NULL OR `expires_at` <= ? ) ORDER BY `id` ASC LIMIT ?',
    nonceTakeover: 'UPDATE `authn_nonce` SET `expires_at` = ? WHERE `k` = ? AND `expires_at` <= ?',
    noncePurge: 'SELECT `k` FROM `authn_nonce` WHERE `expires_at` <= ? ORDER BY `k` ASC LIMIT ?',
    acceptStep: 'UPDATE `authn_mfa` SET `last_step` = ? WHERE `identity` = ? AND `step` = ? AND ( `last_step` IS NULL OR `last_step` < ? )',
    redeemCode: 'UPDATE `authn_recovery_code` SET `used_at` = ? WHERE `identity` = ? AND `code_hash` = ? AND `used_at` IS NULL',
    putPendingUpdate: 'UPDATE `authn_mfa` SET `secret_enc` = ?,`key_id` = ?,`confirmed_at` = ?,`last_step` = ?,`created_at` = ? WHERE `identity` = ? AND `step` = ? AND `confirmed_at` IS NULL',
    confirmExact: 'UPDATE `authn_mfa` SET `confirmed_at` = ? WHERE `identity` = ? AND `step` = ? AND `confirmed_at` IS NULL AND CAST(`secret_enc` AS BINARY) = ?',
    confirmedSteps: 'SELECT `identity`,`step`,`confirmed_at` FROM `authn_mfa` WHERE `identity` = ? AND `confirmed_at` IS NOT NULL',
    confirmedStepNames: 'SELECT `step`,`confirmed_at` FROM `authn_mfa` WHERE `confirmed_at` IS NOT NULL',
  },
  {
    name: 'mssql',
    type: FakeMsSql,
    duplicate: () => Object.assign(new Error('Cannot insert duplicate key row.'), { name: 'RequestError', number: 2601 }),
    secretSelect: 'SELECT [id],[identity],[purpose],CONVERT(varchar(23), expires_at, 121) AS expires_text FROM [authn_secret] WHERE [secret_hash] = ? AND [identity] = ? AND [purpose] = ? AND [used_at] IS NULL',
    secretClaim: 'UPDATE [authn_secret] SET [used_at] = ? WHERE [id] = ? AND [used_at] IS NULL AND [expires_at] > ?',
    secretPurge: 'SELECT [id] FROM [authn_secret] WHERE ( [used_at] IS NOT NULL OR [expires_at] <= ? ) ORDER BY [id] ASC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY',
    nonceTakeover: 'UPDATE [authn_nonce] SET [expires_at] = ? WHERE [k] = ? AND [expires_at] <= ?',
    noncePurge: 'SELECT [k] FROM [authn_nonce] WHERE [expires_at] <= ? ORDER BY [k] ASC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY',
    acceptStep: 'UPDATE [authn_mfa] SET [last_step] = ? WHERE [identity] = ? AND [step] = ? AND ( [last_step] IS NULL OR [last_step] < ? )',
    redeemCode: 'UPDATE [authn_recovery_code] SET [used_at] = ? WHERE [identity] = ? AND [code_hash] = ? AND [used_at] IS NULL',
    putPendingUpdate: 'UPDATE [authn_mfa] SET [secret_enc] = ?,[key_id] = ?,[confirmed_at] = ?,[last_step] = ?,[created_at] = ? WHERE [identity] = ? AND [step] = ? AND [confirmed_at] IS NULL',
    confirmExact: 'UPDATE [authn_mfa] SET [confirmed_at] = ? WHERE [identity] = ? AND [step] = ? AND [confirmed_at] IS NULL AND CAST([secret_enc] AS NVARCHAR(MAX)) = ?',
    confirmedSteps: 'SELECT [identity],[step],[confirmed_at] FROM [authn_mfa] WHERE [identity] = ? AND [confirmed_at] IS NOT NULL',
    confirmedStepNames: 'SELECT [step],[confirmed_at] FROM [authn_mfa] WHERE [confirmed_at] IS NOT NULL',
  },
] as const;

for (const d of DIALECTS) {
  describe(`task 3 store SQL on ${d.name} (compiled, no server)`, function () {
    this.timeout(30000);

    it('DbSecretStore.redeem reads expiry as text and claims with a guarded update', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Update) return { RowsAffected: 1 };
        return [{ id: 'row-1', identity: `user:${ALICE.id}`, purpose: 'reset', expires_text: '2026-06-01 10:01:00.000' }];
      };
      const store = new DbSecretStore(driver);
      const clock = new FakeClock(NOW);
      clock.install();
      try {
        expect(await store.redeem(ALICE, 'reset', 'raw-secret')).to.eq(true);
      } finally {
        clock.uninstall();
      }

      expect(driver.executed.map(sql)).to.deep.eq([d.secretSelect, d.secretClaim]);
      expect(driver.executed[0].params).to.deep.eq([sha256hex('raw-secret'), `user:${ALICE.id}`, 'reset']);
      expect(driver.executed[1].params).to.deep.eq([NOW_TEXT, 'row-1', NOW_TEXT]);
    });

    it('DbSecretStore.purge pages an ordered batch of spent or expired rows', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      expect(await new DbSecretStore(driver).purge(NOW)).to.eq(0);
      expect(driver.executed.map(sql)).to.deep.eq([d.secretPurge]);
      expect(driver.executed[0].params[0]).to.eq(NOW_TEXT);
    });

    it('DbNonceStore takes over an expired key after a duplicate insert', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Insert) throw d.duplicate();
        if (context === QueryContext.Update) return { RowsAffected: 1 };
        return [];
      };

      expect(await new DbNonceStore(driver).claim('jti:1', new Date(NOW.getTime() + 60_000), NOW)).to.eq(true);

      expect(driver.executed.map((e) => e.context)).to.deep.eq([QueryContext.Insert, QueryContext.Update]);
      expect(sql(driver.executed[1])).to.eq(d.nonceTakeover);
      expect(driver.executed[1].params).to.deep.eq(['2026-06-01 10:01:00.000', 'jti:1', NOW_TEXT]);
    });

    it('DbNonceStore.purge pages an ordered batch of expired keys', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      expect(await new DbNonceStore(driver).purge(NOW)).to.eq(0);
      expect(driver.executed.map(sql)).to.deep.eq([d.noncePurge]);
    });

    it('DbMfaStore.acceptStep and redeemRecoveryCode decide in one guarded update', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => ({ RowsAffected: 1 });
      const store = new DbMfaStore(driver);

      expect(await store.acceptStep(ALICE, 'totp', 58_000_000)).to.eq(true);
      expect(await store.redeemRecoveryCode(ALICE, 'code-1')).to.eq(true);

      expect(driver.executed.map(sql)).to.deep.eq([d.acceptStep, d.redeemCode]);
      expect(driver.executed[0].params).to.deep.eq([58_000_000, `user:${ALICE.id}`, 'totp', 58_000_000]);
      expect(driver.executed[1].params.slice(1)).to.deep.eq([`user:${ALICE.id}`, sha256hex('code-1')]);
    });

    it('DbMfaStore.putPending retries the insert when a parallel remove deleted the row', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      let inserts = 0;
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Insert && inserts++ === 0) throw d.duplicate();
        if (context === QueryContext.Update) return { RowsAffected: 0 };
        return [];
      };

      expect(await new DbMfaStore(driver).putPending(ALICE, 'totp', 'v1.new', 'kid-a')).to.eq(true);

      expect(driver.executed.map((e) => e.context)).to.deep.eq([QueryContext.Insert, QueryContext.Update, QueryContext.Select, QueryContext.Insert]);
      expect(sql(driver.executed[1])).to.eq(d.putPendingUpdate);
      expect(driver.executed[1].params.slice(0, 2)).to.deep.eq(['v1.new', 'kid-a']);
      expect(driver.executed[1].params.slice(-2)).to.deep.eq([`user:${ALICE.id}`, 'totp']);
    });

    it('DbMfaStore.putPending is false and writes nothing more when the re-read finds the row confirmed', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Insert) throw d.duplicate();
        if (context === QueryContext.Update) return { RowsAffected: 0 };
        return [{ identity: `user:${ALICE.id}`, step: 'totp', secret_enc: 'v1.old', key_id: 'kid-a', last_step: null, confirmed_text: NOW_TEXT, created_text: NOW_TEXT }];
      };

      expect(await new DbMfaStore(driver).putPending(ALICE, 'totp', 'v1.new', 'kid-a')).to.eq(false);
      expect(driver.executed.map((e) => e.context)).to.deep.eq([QueryContext.Insert, QueryContext.Update, QueryContext.Select]);
    });

    it('DbMfaStore.putPending throws UnexpectedServerError after MAX_TRIES rounds', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Insert) throw d.duplicate();
        if (context === QueryContext.Update) return { RowsAffected: 0 };
        return [];
      };

      let err: unknown;
      try {
        await new DbMfaStore(driver).putPending(ALICE, 'totp', 'v1.new', 'kid-a');
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(UnexpectedServerError);
      expect(String((err as Error).message)).to.not.contain('v1.new');
      expect(driver.executed.filter((e) => e.context === QueryContext.Insert)).to.have.length(8);
      expect(driver.executed).to.have.length(24);
    });

    it('DbMfaStore.confirm with an expected cipher text compares it exactly in one guarded update', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => ({ RowsAffected: 1 });

      expect(await new DbMfaStore(driver).confirm(ALICE, 'totp', NOW, 'v1.expected')).to.eq(true);

      expect(driver.executed.map(sql)).to.deep.eq([d.confirmExact]);
      expect(driver.executed[0].params).to.deep.eq([NOW_TEXT, `user:${ALICE.id}`, 'totp', 'v1.expected']);
    });

    it('DbSecretStore.redeem refuses a row that matched only under a case-blind collation', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Update) return { RowsAffected: 1 };
        return [{ id: 'row-1', identity: `USER:${ALICE.id.toUpperCase()}`, purpose: 'RESET', expires_text: '2026-06-01 10:01:00.000' }];
      };
      const clock = new FakeClock(NOW);
      clock.install();
      try {
        expect(await new DbSecretStore(driver).redeem(ALICE, 'reset', 'raw-secret')).to.eq(false);
      } finally {
        clock.uninstall();
      }
      expect(driver.executed.map((e) => e.context)).to.deep.eq([QueryContext.Select]);
    });

    it('DbSecretStore.redeem runs the same statements for an unknown identity as for a real one with a wrong secret', async () => {
      const redeemWrong = async (identity: IdentityRef) => {
        const driver = await fake(d.type, `n4-${d.name}`);
        const clock = new FakeClock(NOW);
        clock.install();
        try {
          expect(await new DbSecretStore(driver).redeem(identity, 'reset', 'wrong-secret')).to.eq(false);
        } finally {
          clock.uninstall();
        }
        return driver.executed;
      };

      const real = await redeemWrong(ALICE);
      const unknown = await redeemWrong({ type: 'user', id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });

      expect(real.map(sql)).to.deep.eq([d.secretSelect]);
      expect(unknown.map(sql)).to.deep.eq(real.map(sql));
      expect(unknown.map((e) => e.context)).to.deep.eq([QueryContext.Select]);
      expect(unknown[0].params.map((p) => String(p).length)).to.deep.eq(real[0].params.map((p) => String(p).length));
    });

    it('DbSecretStore.redeem refuses an over-long input without a query', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      expect(await new DbSecretStore(driver).redeem(ALICE, 'reset', 'x'.repeat(1025))).to.eq(false);
      expect(driver.executed).to.have.length(0);
    });

    it('DbIdentityLinkStore.list keeps only rows of exactly that identity', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => [
        { id: 'l1', identity_type: 'user', identity_id: ALICE.id.toUpperCase(), provider: 'oidc:g', subject: 'a', email: null, linked_text: NOW_TEXT, last_used_text: null },
        { id: 'l2', identity_type: 'user', identity_id: ALICE.id, provider: 'oidc:g', subject: 'b', email: null, linked_text: NOW_TEXT, last_used_text: null },
      ];
      expect((await new DbIdentityLinkStore(driver).list(ALICE)).map((l) => l.id)).to.deep.eq(['l2']);
    });

    it('DbMfaStore.get and countRecoveryCodes keep only rows of exactly that identity and step', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      const other = `user:${ALICE.id.toUpperCase()}`;
      driver.respond = (stmt) =>
        stmt.includes('authn_recovery_code')
          ? [{ identity: other }, { identity: `user:${ALICE.id}` }]
          : [{ identity: other, step: 'totp', secret_enc: 'v1.x', key_id: 'k', last_step: null, confirmed_text: null, created_text: NOW_TEXT }];
      const store = new DbMfaStore(driver);
      expect(await store.get(ALICE, 'totp')).to.eq(null);
      expect(await store.countRecoveryCodes(ALICE)).to.eq(1);
    });

    it('DbMfaStore.confirmedSteps keeps only confirmed rows of exactly that identity', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => [
        { identity: `user:${ALICE.id.toUpperCase()}`, step: 'webauthn', confirmed_at: NOW },
        { identity: `user:${ALICE.id}`, step: 'totp', confirmed_at: NOW },
        { identity: `user:${ALICE.id}`, step: 'sms', confirmed_at: null },
      ];
      expect(await new DbMfaStore(driver).confirmedSteps(ALICE)).to.deep.eq(['totp']);
      expect(driver.executed.map(sql)).to.deep.eq([d.confirmedSteps]);
      expect(driver.executed[0].params).to.deep.eq([`user:${ALICE.id}`]);
    });

    it('DbMfaStore.confirmedStepNames keeps step names that differ only in case, once each, and only of confirmed rows', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => [
        { step: 'totp', confirmed_at: NOW },
        { step: 'TOTP', confirmed_at: NOW },
        { step: 'totp', confirmed_at: NOW },
        { step: 'sms', confirmed_at: null },
      ];
      expect(await new DbMfaStore(driver).confirmedStepNames()).to.deep.eq(['totp', 'TOTP']);
      expect(driver.executed.map(sql)).to.deep.eq([d.confirmedStepNames]);
    });

    it('DbMfaStore.redeemRecoveryCode refuses an over-long input without a query', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      expect(await new DbMfaStore(driver).redeemRecoveryCode(ALICE, 'x'.repeat(1025))).to.eq(false);
      expect(driver.executed).to.have.length(0);
    });

    it('DbIdentityLinkStore.find refuses a subject that matched only under a case-blind collation', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => [{ id: 'l1', identity_type: 'user', identity_id: ALICE.id, provider: 'oidc:g', subject: 'ALICE', email: null, linked_text: NOW_TEXT, last_used_text: null }];
      const store = new DbIdentityLinkStore(driver);
      expect(await store.find('oidc:g', 'alice')).to.eq(null);
      expect((await store.find('oidc:g', 'ALICE'))?.id).to.eq('l1');
    });

    it('DbIdentityLinkStore.link maps the driver duplicate error to ResourceDuplicated', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      driver.respond = () => {
        throw d.duplicate();
      };
      let err: unknown;
      try {
        await new DbIdentityLinkStore(driver).link(ALICE, { provider: 'p', subject: 's' });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(ResourceDuplicated);
    });
  });
}
