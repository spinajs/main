import { randomUUID } from 'node:crypto';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';
import { AccessTokenGenerationProvider, DbTokenService, TokenOwnerResolver, TokenProfilePolicy, UsersTableTokenOwnerResolver } from '@spinajs/authn-token';
import { DI } from '@spinajs/di';

import type { Scenario } from '../lib.js';
import { bootAuthn } from './_authn-boot.js';
import type { AuthnBoot } from './_authn-boot.js';

const ACTIVE: IdentityStatus = { exists: true, active: true, banned: false, deleted: false };

// The real IdentityStore is @spinajs/users, which authz-testing must not import: status is answered from memory.
class ActiveIdentityStore extends IdentityStore {
  public async findByLogin(): Promise<IdentityRef | null> {
    return null;
  }

  public async status(): Promise<IdentityStatus> {
    return ACTIVE;
  }

  public async display(): Promise<{ email?: string; name?: string }> {
    return {};
  }
}

let boot: AuthnBoot;
let tokens: DbTokenService;
let plaintext: string;

// `users` belongs to @spinajs/users; this is the subset of its columns that the owner resolver reads.
async function createUsersTable(uuid: string): Promise<void> {
  const connection = boot.connection();
  await connection.schema().createTable('users', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Uuid', 36).notNull();
    table.string('Email', 64).unique().notNull();
    table.string('Password', 128).notNull();
    table.string('Login', 64).notNull();
    table.boolean('IsActive').notNull().default().value(0);
    table.dateTime('CreatedAt').notNull().default().dateTime();
    table.dateTime('DeletedAt');
    table.dateTime('LastLoginAt');
  });
  await connection.index().unique().table('users').name('user_uuid_idx').columns(['Uuid']);
  await connection
    .insert()
    .into('users')
    .values({ Uuid: uuid, Email: `${uuid}@bench.test`, Password: 'not-a-hash', Login: uuid, IsActive: 1 });
}

const context = (): AuthnContext => ({ now: new Date(), purpose: 'request' });

export default {
  name: 'token.validate.sqlite',
  description: 'DbTokenService.validate of a valid pat over in-memory sqlite: token row, owner row, in-memory identity status',
  iterations: 5_000,
  warmup: 500,
  setup: async () => {
    boot = await bootAuthn({});
    boot.own(IdentityStore, TokenService, DbTokenService, TokenOwnerResolver, UsersTableTokenOwnerResolver, TokenProfilePolicy, AccessTokenGenerationProvider, ActiveIdentityStore);
    DI.register(ActiveIdentityStore).as(IdentityStore);

    const owner: IdentityRef = { type: 'user', id: randomUUID() };
    await createUsersTable(owner.id);
    tokens = await boot.resolve(DbTokenService);
    const created = await tokens.create(owner, { name: 'bench', kind: 'pat', expiresAt: new Date(Date.now() + 86_400_000) }, context());
    if (!created.ok) {
      throw new Error(`token not minted: ${created.code}`);
    }
    plaintext = created.plaintext;
  },
  verify: async () => {
    const valid = await tokens.validate(plaintext, context());
    const unknown = await tokens.validate(`${plaintext}x`, context());
    if (!valid.ok || unknown.ok) {
      throw new Error(`expected the minted token valid and a mangled one refused, got ${valid.ok} and ${unknown.ok}`);
    }
  },
  teardown: async () => {
    DI.unregister(ActiveIdentityStore);
    await boot?.dispose();
  },
  run: () => tokens.validate(plaintext, context()),
} satisfies Scenario;
