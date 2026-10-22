import 'mocha';
import { expect } from 'chai';
import { Autoinject, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Connection, Migration, Model, ModelBase, Orm, OrmMigration, OrmMigrator, Primary } from '@spinajs/orm';
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

const CONNECTION = 'authn-local-cli';
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
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: CONNECTION, Migration: { Table: 'orm_migrations', OnStartup: true } }],
      },
    };
  }
}

/** Keeps the generated password off the test output; DI builds it as the cli builds the command. */
class QuietSetUserPassword extends SetUserPassword {
  protected print(): void {}
}

// The cli resolves only the command it runs; on a Migration.OnStartup connection a model query throws until
// OrmMigrator ran the boot pass, so the command must bring it, not only the Orm its stores inject.
describe('authn-local cli commands on a Migration.OnStartup connection', function () {
  this.timeout(60_000);

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
    DI.setESMModuleSupport();
    for (const [type, as] of registered) DI.register(type).as(as as never);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    Migration(CONNECTION)(CliIdentities_2026_10_21_00_00_00);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await DI.get(Orm)?.dispose();
    DI.uncache(OrmMigrator);
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
