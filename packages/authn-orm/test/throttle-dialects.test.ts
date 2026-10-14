/** Compiles the throttle's queries with the MySQL and MSSQL dialects, against fake drivers: no server needed. */
import { DEFAULT_THROTTLE, FakeClock, pwKeys } from '@spinajs/authn-testing';
import '@spinajs/log';
import { OrmException, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { DbAuthnThrottle } from '../src/index.js';
import { driverDialect } from '../src/support/sql.js';
import { FakeMsSql, FakeMySql, fake, sql } from './support/fake-drivers.js';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const ctx = { now: NOW, purpose: 'login' as const };

const DIALECTS = [
  {
    name: 'mysql',
    type: FakeMySql,
    duplicate: () => new OrmException('Error executing orm command ', { Name: 'mysql' }, 'INSERT', [], Object.assign(new Error("Duplicate entry 'x' for key 'PRIMARY'"), { code: 'ER_DUP_ENTRY', errno: 1062 })),
    blocked: 'SELECT `k`,CAST(next_allowed_at AS CHAR) AS next_text FROM `authn_throttle` WHERE `k` IN (?) AND `next_allowed_at` > ?',
    live: 'SELECT `k`,`attempts`,CAST(last_attempt_at AS CHAR) AS last_text,CAST(next_allowed_at AS CHAR) AS next_text FROM `authn_throttle` WHERE `k` IN (?) AND ( `last_attempt_at` > ? OR `next_allowed_at` > ? )',
    cas: 'UPDATE `authn_throttle` SET `attempts` = ?,`last_attempt_at` = ?,`next_allowed_at` = ?,`updated_at` = ? WHERE `k` = ? AND `attempts` = ? AND `next_allowed_at` <= ? AND `last_attempt_at` > ?',
    takeover: 'UPDATE `authn_throttle` SET `attempts` = ?,`last_attempt_at` = ?,`next_allowed_at` = ?,`updated_at` = ? WHERE `k` = ? AND `next_allowed_at` <= ? AND `last_attempt_at` <= ?',
    purge: 'SELECT `k` FROM `authn_throttle` WHERE `last_attempt_at` <= ? AND `next_allowed_at` <= ? ORDER BY `k` ASC LIMIT ?',
    take: 'DELETE FROM `authn_throttle` WHERE `k` = ? AND `attempts` = ? AND ( `last_attempt_at` > ? OR `next_allowed_at` > ? )',
    lower: 'UPDATE `authn_throttle` SET `attempts` = ?,`next_allowed_at` = ?,`updated_at` = ? WHERE `k` = ? AND `attempts` = ? AND ( `last_attempt_at` > ? OR `next_allowed_at` > ? )',
    clear: 'DELETE FROM `authn_throttle` WHERE `k` = ?',
  },
  {
    // The table name keeps its backticks: MsSqlOrmDriver.executeOnDb, which these fakes replace, strips them.
    name: 'mssql',
    type: FakeMsSql,
    duplicate: () => Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_authn_throttle'."), { name: 'RequestError', number: 2627 }),
    blocked: 'SELECT [k],CONVERT(varchar(23), next_allowed_at, 121) AS next_text FROM [authn_throttle] WHERE [k] IN (?) AND [next_allowed_at] > ?',
    live: 'SELECT [k],[attempts],CONVERT(varchar(23), last_attempt_at, 121) AS last_text,CONVERT(varchar(23), next_allowed_at, 121) AS next_text FROM [authn_throttle] WHERE [k] IN (?) AND ( [last_attempt_at] > ? OR [next_allowed_at] > ? )',
    cas: 'UPDATE [authn_throttle] SET [attempts] = ?,[last_attempt_at] = ?,[next_allowed_at] = ?,[updated_at] = ? WHERE [k] = ? AND [attempts] = ? AND [next_allowed_at] <= ? AND [last_attempt_at] > ?',
    takeover: 'UPDATE [authn_throttle] SET [attempts] = ?,[last_attempt_at] = ?,[next_allowed_at] = ?,[updated_at] = ? WHERE [k] = ? AND [next_allowed_at] <= ? AND [last_attempt_at] <= ?',
    purge: 'SELECT [k] FROM [authn_throttle] WHERE [last_attempt_at] <= ? AND [next_allowed_at] <= ? ORDER BY [k] ASC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY',
    take: 'DELETE FROM [authn_throttle] WHERE [k] = ? AND [attempts] = ? AND ( [last_attempt_at] > ? OR [next_allowed_at] > ? )',
    lower: 'UPDATE [authn_throttle] SET [attempts] = ?,[next_allowed_at] = ?,[updated_at] = ? WHERE [k] = ? AND [attempts] = ? AND ( [last_attempt_at] > ? OR [next_allowed_at] > ? )',
    clear: 'DELETE FROM [authn_throttle] WHERE [k] = ?',
  },
] as const;

for (const d of DIALECTS) {
  describe(`DbAuthnThrottle SQL on ${d.name} (compiled, no server)`, function () {
    this.timeout(30000);

    it(`detects the ${d.name} dialect`, async () => {
      expect(driverDialect(await fake(d.type, `n4-${d.name}`))).to.eq(d.name);
    });

    it('reads datetimes as text and claims a live row with a compare-and-set', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      const throttle = new DbAuthnThrottle(driver, DEFAULT_THROTTLE);
      const [account] = pwKeys('a@example.test', '192.0.2.1');
      const k = throttle.rowKey('login', account);
      driver.respond = (stmt, context) => {
        if (context === QueryContext.Update) return { RowsAffected: 1 };
        if (stmt.includes('last_text')) return [{ k, attempts: 2, last_text: '2026-06-01 09:59:00.000', next_text: '2026-06-01 09:59:00.000' }];
        return [];
      };

      expect(await throttle.attempt([account], 'login', ctx)).to.deep.eq({ allowed: true });

      expect(driver.executed.map(sql)).to.deep.eq([d.blocked, d.live, d.cas]);
      expect(driver.executed[2].params).to.deep.eq([3, '2026-06-01 10:00:00.000', '2026-06-01 10:00:00.000', '2026-06-01 10:00:00.000', k, 2, '2026-06-01 10:00:00.000', '2026-05-31 10:00:00.000']);
    });

    it(`treats a duplicate key error as a lost insert and tries the stale takeover`, async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      const throttle = new DbAuthnThrottle(driver, DEFAULT_THROTTLE);
      const [account] = pwKeys('b@example.test', '192.0.2.1');
      driver.respond = (_stmt, context) => {
        if (context === QueryContext.Insert) throw d.duplicate();
        if (context === QueryContext.Update) return { RowsAffected: 1 };
        return [];
      };

      expect(await throttle.attempt([account], 'login', ctx)).to.deep.eq({ allowed: true });

      expect(driver.executed.map((e) => e.context)).to.deep.eq([QueryContext.Select, QueryContext.Select, QueryContext.Insert, QueryContext.Update]);
      expect(sql(driver.executed[3])).to.eq(d.takeover);
    });

    it('succeeds by taking the account-ip row, then lowering the ip row, then deleting the account row', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      const throttle = new DbAuthnThrottle(driver, DEFAULT_THROTTLE);
      const keys = pwKeys('c@example.test', '192.0.2.1');
      const [accountK, bookK, ipK] = keys.map((k) => throttle.rowKey('login', k));
      driver.respond = (stmt, context) => {
        if (context !== QueryContext.Select) return { RowsAffected: 1 };
        if (stmt.includes('last_text')) {
          return [
            { k: bookK, attempts: 2, last_text: '2026-06-01 09:59:00.000', next_text: '2026-06-01 09:59:00.000' },
            { k: ipK, attempts: 30, last_text: '2026-06-01 09:59:30.000', next_text: '2026-06-01 10:00:10.000' },
          ];
        }
        return [];
      };
      const clock = new FakeClock(NOW);
      clock.install();
      try {
        await throttle.succeed(keys, 'login');
      } finally {
        clock.uninstall();
      }

      const live = ['2026-05-31 10:00:00.000', '2026-06-01 10:00:00.000'];
      // 30 - 2 = 28 attempts, 8 past free 20: 2^8 s after the ip row's last attempt (09:59:30).
      expect(driver.executed.map((e) => [e.context, sql(e), e.params])).to.deep.eq([
        [QueryContext.Select, d.live, [bookK, ...live]],
        [QueryContext.Delete, d.take, [bookK, 2, ...live]],
        [QueryContext.Select, d.live, [ipK, ...live]],
        [QueryContext.Update, d.lower, [28, '2026-06-01 10:03:46.000', '2026-06-01 10:00:00.000', ipK, 30, ...live]],
        [QueryContext.Delete, d.clear, [accountK]],
      ]);
    });

    it('orders the purge batch by k', async () => {
      const driver = await fake(d.type, `n4-${d.name}`);
      const throttle = new DbAuthnThrottle(driver, DEFAULT_THROTTLE);

      expect(await throttle.purge(NOW)).to.eq(0);

      expect(driver.executed.map(sql)).to.deep.eq([d.purge]);
    });
  });
}
