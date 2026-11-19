import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cli } from '@spinajs/cli';
import { Autoinject, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Connection, Migration, Model, ModelBase, Orm, OrmMigration, OrmMigrationGuard, OrmMigrator, PendingMigrationsException, Primary } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthnEventSink, AuthnThrottle, IdentityStore, PasswordCredentialStore, PasswordService, SecretStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { AuthnAudit } from '@spinajs/authn/audit';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { Argon2PasswordHasher, PasswordHasher } from '../src/hasher.js';
import { PasswordMail, PasswordMailer } from '../src/mailer.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';
import { PasswordAgeSource, PasswordExpirationJob } from '../src/expiration.js';
import { ExpirePasswords } from '../src/cli/ExpirePasswords.js';
import { SetUserPassword } from '../src/cli/SetUserPassword.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const CONNECTION = 'authn-local-cli';

/** A file, so the migrate-up run and the commands' boot are separate Orms on one database. */
let dbFile = '';
const TABLE = 'authn_local_cli_identities';

@Connection(CONNECTION)
@Model(TABLE)
class CliIdentityRow extends ModelBase {
  @Primary()
  public Id: number;

  public Login: string;
}

class CliIdentities_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(TABLE, (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Login', 64).notNull();
    });
    await connection.insert().into(TABLE).values({ Login: 'ann@example.com' });
  }

  public async down(): Promise<void> {}
}

/** A DB-backed store as an app's is: it injects the Orm, never the migrator, and queries a model. */
class DbBackedIdentityStore extends FakeIdentityStore {
  @Autoinject(Orm)
  protected Orm: Orm;

  public async findByLogin(login: string): Promise<IdentityRef | null> {
    const row = await CliIdentityRow.where('Login', login).first();
    return row ? super.findByLogin(login) : null;
  }
}

class DbBackedAgeSource extends PasswordAgeSource {
  @Autoinject(Orm)
  protected Orm: Orm;

  public rows = -1;

  public async passwordsSetBefore(): Promise<readonly IdentityRef[]> {
    this.rows = (await CliIdentityRow.all()).length;
    return [];
  }
}

class CliOrmBackoffThrottle extends FakeBackoffThrottle {
  constructor() {
    super(DEFAULT_THROTTLE);
  }
}

class CliOrmMailer extends PasswordMailer {
  public async send(_mail: PasswordMail): Promise<void> {}
}

class CliOrmConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: { local: { hasher: { maxConcurrent: 2 }, expiration: { enabled: true, maxAgeDays: 10 }, generator: { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', '0123456789'] } } },
      db: {
        DefaultConnection: CONNECTION,
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: CONNECTION, Migration: { Table: 'orm_migrations' } }],
      },
    };
  }
}

/** Keeps the generated password off the test output; DI builds it as the cli builds the command. */
class QuietSetUserPassword extends SetUserPassword {
  protected print(): void {}
}

// The cli resolves only the command it runs, and the command boots the Orm its DB-backed stores query: that boot
// refuses a database migrate-up has not run on.
describe('authn-local cli commands boot the Orm', function () {
  this.timeout(60_000);

  let dir = '';

  const registered = [
    [CliOrmConfiguration, Configuration],
    [DbBackedIdentityStore, IdentityStore],
    [MemoryPasswordCredentialStore, PasswordCredentialStore],
    [MemorySessionIssuer, SessionIssuer],
    [RecordingEventSink, AuthnEventSink],
    [CliOrmBackoffThrottle, AuthnThrottle],
    [MemorySecretStore, SecretStore],
    [CliOrmMailer, PasswordMailer],
    [DbBackedAgeSource, PasswordAgeSource],
  ] as const;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-local-cli-'));
    dbFile = path.join(dir, 'local-cli.sqlite');
    DI.setESMModuleSupport();
    for (const [type, as] of registered) DI.register(type).as(as as never);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    Migration(CONNECTION)(CliIdentities_2026_10_21_00_00_00);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await DI.get(Orm)?.dispose();
    DI.uncache(OrmMigrator);
    DI.uncache(OrmMigrationGuard);
    DI.uncache(Orm);
    for (const t of [DbBackedIdentityStore, IdentityStore, DbBackedAgeSource, PasswordAgeSource, PasswordService, LocalPasswordService, PasswordExpirationJob, QuietSetUserPassword, ExpirePasswords]) DI.uncache<unknown>(t);
  });

  after(() => {
    DI.unregister(CliIdentities_2026_10_21_00_00_00);
    DI.unregister(SqliteOrmDriver);
    DI.uncache('orm-driver-sqlite');
    for (const [type, as] of registered) {
      DI.unregister(type);
      DI.uncache<unknown>(type);
      DI.uncache<unknown>(as);
    }
    // AuthnAudit keeps the sinks of its first resolve; a later suite registers its own RecordingEventSink.
    for (const t of [PasswordHasher, Argon2PasswordHasher, LocalPasswordPolicy, AuthnAudit]) DI.uncache<unknown>(t);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the commands refuse an unmigrated database when they run, and name migrate-up', async () => {
    await expect((await DI.resolve(QuietSetUserPassword)).execute('ann@example.com', { generate: true })).to.be.rejectedWith(PendingMigrationsException, /npx spinajs migrate-up/);
    await expect((await DI.resolve(ExpirePasswords)).execute()).to.be.rejectedWith(PendingMigrationsException, /npx spinajs migrate-up/);
  });

  it('--help of each command works on an unmigrated database and boots no Orm', async () => {
    const configuration = await DI.resolve<Configuration>(Configuration);
    const dirs = configuration.get<unknown>('system.dirs.cli');
    configuration.set('system.dirs.cli', [fileURLToPath(new URL('../src/cli', import.meta.url))]);
    try {
      for (const name of ['authn:password', 'authn:password-expire']) {
        const argv = () => ['node', 'spinajs', name, '--help'];
        DI.register(argv).as('__cli_argv_provider__');
        try {
          await DI.resolve(Cli);
        } finally {
          DI.unregister('__cli_argv_provider__', argv);
          DI.uncache(Cli);
        }
        expect(DI.RootContainer.isResolved(Orm), name).to.equal(false);
      }
    } finally {
      configuration.set('system.dirs.cli', dirs);
    }
  });

  // mocha runs a suite's own tests before its nested suites: the refusal above sees the database before this migrates it
  describe('after migrate-up', () => {
    before(async () => {
      const { orm: tool } = await migrateTestDatabase(DI.child());
      await tool.dispose();
    });

    it('authn:password finds the login through a DB-backed store and sets the password', async () => {
      const identities = (await DI.resolve(IdentityStore)) as DbBackedIdentityStore;
      const ann = identities.add({ login: 'ann@example.com' });

      const command = await DI.resolve(QuietSetUserPassword);
      await command.execute('ann@example.com', { generate: true });

      const passwords = DI.resolve(PasswordCredentialStore) as MemoryPasswordCredentialStore;
      expect(await passwords.get(ann)).to.be.a('string');
    });

    it('authn:password-expire reads a DB-backed age source', async () => {
      const command = await DI.resolve(ExpirePasswords);
      await command.execute();

      const ages = (await DI.resolve(PasswordAgeSource)) as DbBackedAgeSource;
      expect(ages.rows).to.equal(1);
    });
  });
});
