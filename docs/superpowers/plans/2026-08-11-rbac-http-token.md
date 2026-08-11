# `@spinajs/rbac-http-token` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New monorepo package providing DB-persisted personal access tokens (PAT) assigned to users, with rbac role intersection, expiry, HTTP controller API, CLI commands, token policy and auth middleware.

**Architecture:** Opaque tokens (`spt_` prefix + 32 random bytes base64url), only SHA-256 hash stored. `TokenAuthMiddleware` (a `ServerMiddleware` running after `RbacMiddleware`) authenticates `Authorization: Bearer` / `x-api-key` requests by narrowing `req.storage.User.Role` to `token.Roles ∩ user.Role`, so all existing rbac machinery works unchanged. Business logic is functional actions (`actions.ts`, `_chain`/`_check_arg`/`_ev` pattern from `@spinajs/rbac`). Only injectable service: `AccessTokenGenerationProvider`, swappable via config.

**Tech Stack:** TypeScript ESM+CJS dual build, @spinajs/orm (sqlite in tests), @spinajs/http, @spinajs/rbac, @spinajs/rbac-http, @spinajs/cli, @spinajs/queue events, mocha/chai/sinon.

**Spec:** `docs/superpowers/specs/2026-08-11-rbac-http-token-design.md`

## Global Constraints

- All comments, identifiers, docs: English.
- All `@spinajs/*` dependency versions: exact `2.0.505`.
- ESM source: relative imports MUST end with `.js` (compiled extension), e.g. `import { AccessToken } from './models/AccessToken.js'`.
- Package `"type": "module"`; tests run with `ts-mocha -p tsconfig.json test/**/*.test.ts` from the package directory.
- Cross-package rule: rbac-http-token tests import sibling packages from their **compiled lib** — after modifying `packages/rbac-http` you MUST run its build before dependent tests (Task 7).
- Token plaintext never logged, never stored, returned exactly once.
- Working directory for all commands: `c:\Users\grzch\SourceCodes\Spinajs\main` unless stated.
- Commit after every green test cycle; commit messages in English, conventional style (`feat:`, `test:`, `fix:`, `chore:`).

---

### Task 1: Package scaffold

**Files:**
- Create: `packages/rbac-http-token/package.json`
- Create: `packages/rbac-http-token/tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`
- Create: `packages/rbac-http-token/.mocharc.json`, `.eslintrc.cjs`, `.eslintignore`, `.npmignore`, `.prettierrc`
- Create: `packages/rbac-http-token/src/index.ts` (empty export stub)
- Create: `packages/rbac-http-token/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: buildable empty package `@spinajs/rbac-http-token` v `2.0.505`; all later tasks add files under `packages/rbac-http-token/`.

- [ ] **Step 1: Copy config files from sibling**

Copy from `packages/rbac-http-user`: `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `.mocharc.json`, `.eslintrc.cjs`, `.eslintignore`, `.npmignore`, `.prettierrc` verbatim into `packages/rbac-http-token/`.

```powershell
New-Item -ItemType Directory -Force packages/rbac-http-token/src, packages/rbac-http-token/test
foreach ($f in 'tsconfig.json','tsconfig.mjs.json','tsconfig.cjs.json','.mocharc.json','.eslintrc.cjs','.eslintignore','.npmignore','.prettierrc') { Copy-Item "packages/rbac-http-user/$f" "packages/rbac-http-token/$f" }
```

- [ ] **Step 2: Write package.json**

`packages/rbac-http-token/package.json` — mirror rbac-http-user, adjusted:

```json
{
  "name": "@spinajs/rbac-http-token",
  "version": "2.0.505",
  "description": "Personal access tokens (PAT) for spinajs HTTP routes - DB persisted, rbac-aware, with controller API and CLI",
  "main": "lib/cjs/index.js",
  "module": "lib/mjs/index.js",
  "exports": {
    ".": {
      "types": "./lib/mjs/index.d.ts",
      "import": "./lib/mjs/index.js",
      "require": "./lib/cjs/index.js"
    }
  },
  "type": "module",
  "private": false,
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=16.11" },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": ["lib/**/*"],
  "repository": { "type": "git", "url": "git+https://github.com/spinajs/main.git" },
  "keywords": ["spinajs", "rbac", "token", "pat"],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": { "url": "https://github.com/spinajs/main/issues" },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/cli": "2.0.505",
    "@spinajs/configuration": "2.0.505",
    "@spinajs/di": "2.0.505",
    "@spinajs/exceptions": "2.0.505",
    "@spinajs/http": "2.0.505",
    "@spinajs/log": "2.0.505",
    "@spinajs/orm": "2.0.505",
    "@spinajs/queue": "2.0.505",
    "@spinajs/rbac": "2.0.505",
    "@spinajs/rbac-http": "2.0.505",
    "@spinajs/util": "2.0.505",
    "@spinajs/validation": "2.0.505",
    "lodash": "^4.17.21",
    "luxon": "^3.6.1",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@spinajs/orm-sqlite": "2.0.505",
    "cookie-signature": "^1.2.2"
  }
}
```

- [ ] **Step 3: Stub index.ts and README**

`packages/rbac-http-token/src/index.ts`:

```ts
export {};
```

`packages/rbac-http-token/README.md`:

```markdown
# @spinajs/rbac-http-token

Personal access tokens for spinajs HTTP routes.
```

- [ ] **Step 4: Install workspace deps and verify build**

```powershell
npm install
cd packages/rbac-http-token && npm run compile
```

Expected: tsc exits 0, `lib/mjs/index.js` exists.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): scaffold package"
```

---

### Task 2: Interfaces + AccessToken model + migration

**Files:**
- Create: `packages/rbac-http-token/src/interfaces.ts`
- Create: `packages/rbac-http-token/src/models/AccessToken.ts`
- Create: `packages/rbac-http-token/src/migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.ts`
- Create: `packages/rbac-http-token/test/db-common.ts`
- Test: `packages/rbac-http-token/test/model.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `@spinajs/orm` ModelBase/decorators, `@spinajs/rbac` User.
- Produces:
  - `class AccessToken extends ModelBase<AccessToken>` — fields `Id: number` (hidden), `Uuid: string`, `Name: string`, `Token: string` (SHA-256 hash, hidden), `user_id: number` (hidden), `Roles: string[]` (`@Set()`), `ExpiresAt: DateTime | null`, `CreatedAt: DateTime`, `LastUsedAt: DateTime | null`, `User: SingleRelation<User>`; table `rbac_access_tokens`, connection `default`.
  - `abstract class AccessTokenGenerationProvider { generate(): Promise<IGeneratedToken>; hash(plaintext: string): string; }`
  - `interface IGeneratedToken { Plaintext: string; Hash: string; }`
  - `interface ITokenAuthInfo { Uuid: string; }` + declaration-merge `TokenAuth?: ITokenAuthInfo` into `IRbacAsyncStorage` of `@spinajs/rbac`.
  - Test helper `TestConfiguration` (sqlite in-memory, migrations+models dirs) in `test/db-common.ts`.

- [ ] **Step 1: Write interfaces**

`packages/rbac-http-token/src/interfaces.ts`:

```ts
export interface IGeneratedToken {
  /**
   * Full token as handed to the user, e.g. `spt_<base64url>`. Shown exactly once.
   */
  Plaintext: string;

  /**
   * SHA-256 hex digest of the plaintext - the only thing that is persisted.
   */
  Hash: string;
}

/**
 * Token generation algorithm. Replaceable via config
 * `rbac.token.generation.service` - same pattern as `rbac.password.service`.
 */
export abstract class AccessTokenGenerationProvider {
  /**
   * Generates a fresh token. Plaintext leaves the server once; only the hash is stored.
   */
  public abstract generate(): Promise<IGeneratedToken>;

  /**
   * Deterministic hash of a presented plaintext, used for DB lookup.
   */
  public abstract hash(plaintext: string): string;
}

/**
 * Marker stored on request async storage when a request was authenticated
 * with an access token instead of a session.
 */
export interface ITokenAuthInfo {
  /**
   * Uuid of the AccessToken row - safe to log; never the token itself.
   */
  Uuid: string;
}

declare module '@spinajs/rbac' {
  interface IRbacAsyncStorage {
    /**
     * Set by TokenAuthMiddleware when the request carries a valid access token.
     */
    TokenAuth?: ITokenAuthInfo;
  }
}
```

- [ ] **Step 2: Write model**

`packages/rbac-http-token/src/models/AccessToken.ts`:

```ts
import { BelongsTo, Connection, CreatedAt, DT, Hidden, Model, ModelBase, Primary, Set, SingleRelation } from '@spinajs/orm';
import { User } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { _check_arg, _default } from '@spinajs/util';

/**
 * Personal access token. Only the SHA-256 hash of the token is stored;
 * the plaintext is returned once at creation and cannot be recovered.
 */
@Connection('default')
@Model('rbac_access_tokens')
export class AccessToken extends ModelBase<AccessToken> {
  public constructor(data?: Partial<AccessToken>) {
    super(data);
    this.Uuid = _check_arg(_default(uuidv4()))(this.Uuid, 'uuid');
  }

  /**
   * Internal row id, never leaves the process. Tokens are addressed by Uuid.
   */
  @Primary()
  @Hidden()
  public Id!: number;

  /**
   * Public identifier used by the API and CLI.
   */
  public Uuid!: string;

  /**
   * Human readable label ("ci deploy key").
   */
  public Name!: string;

  /**
   * SHA-256 hex digest of the plaintext token. Hidden: even the hash is
   * internal - leaking it invites offline correlation.
   */
  @Hidden()
  public Token!: string;

  /**
   * Roles allowed on this token. Effective roles at request time are the
   * intersection of this list with the owner's current roles.
   */
  @Set()
  public Roles!: string[];

  /**
   * Absolute expiration. Null = never expires.
   */
  @DT()
  public ExpiresAt!: DateTime | null;

  @CreatedAt()
  public CreatedAt!: DateTime;

  /**
   * Last successful authentication with this token. Updated throttled.
   */
  @DT()
  public LastUsedAt!: DateTime | null;

  @Hidden()
  @BelongsTo('User')
  public User!: SingleRelation<User>;

  @Hidden()
  public user_id!: number;

  /**
   * True when the token carries an expiration in the past.
   */
  public get IsExpired(): boolean {
    return !!this.ExpiresAt && this.ExpiresAt <= DateTime.now();
  }
}
```

- [ ] **Step 3: Write migration**

`packages/rbac-http-token/src/migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.ts`:

```ts
/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class RbacHttpTokenInitial_2026_08_11_01_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('rbac_access_tokens', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Uuid', 36).notNull();
      table.string('Name', 128).notNull();
      table.string('Token', 64).notNull();
      table.string('Roles', 512).notNull();
      table.dateTime('ExpiresAt');
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('LastUsedAt');
      table.int('user_id').notNull();
      table.foreignKey('user_id').references('users', 'Id').cascade();
    });

    await connection.index().unique().table('rbac_access_tokens').name('access_token_hash_idx').columns(['Token']);
    await connection.index().unique().table('rbac_access_tokens').name('access_token_uuid_idx').columns(['Uuid']);
    await connection.index().table('rbac_access_tokens').name('access_token_user_idx').columns(['user_id']);
    await connection.index().table('rbac_access_tokens').name('access_token_expires_idx').columns(['ExpiresAt']);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
```

- [ ] **Step 4: Update index.ts**

`packages/rbac-http-token/src/index.ts`:

```ts
export * from './interfaces.js';
export * from './models/AccessToken.js';
export * from './migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.js';
```

- [ ] **Step 5: Write test config helper**

`packages/rbac-http-token/test/db-common.ts` — modeled on `packages/rbac-http-user/test/db-common.ts`:

```ts
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Boots in-memory sqlite with rbac + this package's migrations and models.
 * No http server.
 */
export class DbTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          migrations: [dir('./../src/migrations')],
          models: [dir('./../src/models')],
        },
      },
      rbac: {
        defaultRole: 'guest',
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          },
        },
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: {},
        },
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          validation: {
            service: 'BasicPasswordValidationProvider',
            rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' },
          },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      },
      queue: {
        default: 'default-test-queue',
        connections: [{ service: 'BlackHoleQueueClient', name: 'default-test-queue' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
    };
  }
}
```

- [ ] **Step 6: Write failing model test**

`packages/rbac-http-token/test/model.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { User, create } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';

describe('AccessToken model', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(DbTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  it('persists and loads a token with roles set and null expiry', async () => {
    const { User: owner } = await create('owner@spinajs.com', 'owner', 'password123', ['user']);

    const token = new AccessToken({
      Name: 'test token',
      Token: 'a'.repeat(64),
      Roles: ['user'],
      ExpiresAt: null,
      user_id: owner.Id,
    });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.Name).to.equal('test token');
    expect(loaded.Roles).to.deep.equal(['user']);
    expect(loaded.ExpiresAt).to.be.null;
    expect(loaded.IsExpired).to.be.false;
    expect(loaded.user_id).to.equal(owner.Id);
  });

  it('IsExpired is true for past ExpiresAt', async () => {
    const { User: owner } = await create('owner2@spinajs.com', 'owner2', 'password123', ['user']);
    const token = new AccessToken({
      Name: 'expired',
      Token: 'b'.repeat(64),
      Roles: ['user'],
      ExpiresAt: DateTime.now().minus({ hours: 1 }),
      user_id: owner.Id,
    });
    await token.insert();

    const loaded = await AccessToken.where('Uuid', token.Uuid).firstOrFail();
    expect(loaded.IsExpired).to.be.true;
  });

  it('hides hash, ids and owner when dehydrated', async () => {
    const { User: owner } = await create('owner3@spinajs.com', 'owner3', 'password123', ['user']);
    const token = new AccessToken({
      Name: 'hidden fields',
      Token: 'c'.repeat(64),
      Roles: ['user'],
      ExpiresAt: null,
      user_id: owner.Id,
    });
    await token.insert();

    const json = token.toJSON();
    expect(json).to.not.have.property('Token');
    expect(json).to.not.have.property('Id');
    expect(json).to.not.have.property('user_id');
    expect(json).to.have.property('Uuid');
    expect(json).to.have.property('Name');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/model.test.ts
```

Expected: FAIL before Step 2-4 files exist (module not found); after writing them it should PASS. Order note: if you wrote model/migration before the test, this run may already pass — that is acceptable, the failing checkpoint is the missing-module state.

- [ ] **Step 8: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/model.test.ts
```

Expected: 3 passing.

- [ ] **Step 9: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): AccessToken model, migration, interfaces"
```

---

### Task 3: SecureRandomTokenProvider (generator)

**Files:**
- Create: `packages/rbac-http-token/src/generator.ts`
- Test: `packages/rbac-http-token/test/generator.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `AccessTokenGenerationProvider`, `IGeneratedToken` from Task 2.
- Produces: `@Injectable(AccessTokenGenerationProvider) class SecureRandomTokenProvider` reading config `rbac.token.prefix` (default `spt_`) and `rbac.token.length` (random bytes, default 32). `generate()` returns `{ Plaintext: 'spt_<43 chars base64url>', Hash: <64 hex chars> }`; `hash(plaintext)` = SHA-256 hex of the full plaintext (prefix included).

- [ ] **Step 1: Write failing test**

`packages/rbac-http-token/test/generator.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { createHash } from 'crypto';

import { SecureRandomTokenProvider } from '../src/generator.js';

describe('SecureRandomTokenProvider', () => {
  const make = () => {
    const p = new SecureRandomTokenProvider();
    // @Config injected fields set by hand - no DI container needed
    Object.defineProperty(p, 'Prefix', { value: 'spt_', writable: true });
    Object.defineProperty(p, 'Length', { value: 32, writable: true });
    return p;
  };

  it('generates prefixed base64url token with matching sha256 hash', async () => {
    const p = make();
    const t = await p.generate();

    expect(t.Plaintext).to.match(/^spt_[A-Za-z0-9_-]{43}$/);
    expect(t.Hash).to.equal(createHash('sha256').update(t.Plaintext).digest('hex'));
  });

  it('generates unique tokens', async () => {
    const p = make();
    const a = await p.generate();
    const b = await p.generate();
    expect(a.Plaintext).to.not.equal(b.Plaintext);
  });

  it('hash() is deterministic and matches generate()', async () => {
    const p = make();
    const t = await p.generate();
    expect(p.hash(t.Plaintext)).to.equal(t.Hash);
    expect(p.hash(t.Plaintext)).to.equal(p.hash(t.Plaintext));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/generator.test.ts
```

Expected: FAIL — `Cannot find module '../src/generator.js'`.

- [ ] **Step 3: Write implementation**

`packages/rbac-http-token/src/generator.ts`:

```ts
import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

import { AccessTokenGenerationProvider, IGeneratedToken } from './interfaces.js';

/**
 * Default token algorithm: `<prefix>` + N crypto-random bytes base64url encoded.
 * The stable prefix makes leaked tokens findable by secret scanners.
 */
@Injectable(AccessTokenGenerationProvider)
export class SecureRandomTokenProvider extends AccessTokenGenerationProvider {
  @Config('rbac.token.prefix', 'spt_')
  protected Prefix: string;

  @Config('rbac.token.length', 32)
  protected Length: number;

  public async generate(): Promise<IGeneratedToken> {
    const plaintext = `${this.Prefix}${randomBytes(this.Length).toString('base64url')}`;
    return { Plaintext: plaintext, Hash: this.hash(plaintext) };
  }

  public hash(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './generator.js';
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/generator.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): SecureRandomTokenProvider generator"
```

---

### Task 4: Queue events

**Files:**
- Create: `packages/rbac-http-token/src/events/AccessTokenEvent.ts`
- Create: `packages/rbac-http-token/src/events/AccessTokenCreated.ts`
- Create: `packages/rbac-http-token/src/events/AccessTokenDeleted.ts`
- Create: `packages/rbac-http-token/src/events/AccessTokenRoleGranted.ts`
- Create: `packages/rbac-http-token/src/events/AccessTokenRoleRevoked.ts`
- Create: `packages/rbac-http-token/src/events/index.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `AccessToken` from Task 2, `QueueEvent`/`@Event` from `@spinajs/queue` (pattern: `packages/rbac/src/events/UserEvent.ts`).
- Produces: event classes carrying `TokenUuid: string` (+ `Role: string` on grant/revoke), constructed as `new AccessTokenCreated(token)` / `new AccessTokenRoleGranted(token, role)`. Used by Task 5 actions.

- [ ] **Step 1: Write events**

`packages/rbac-http-token/src/events/AccessTokenEvent.ts`:

```ts
import { QueueEvent, Event } from '@spinajs/queue';
import { AccessToken } from '../models/AccessToken.js';

@Event()
export class AccessTokenEvent extends QueueEvent {
  /**
   * Public token identifier. Never the token material.
   */
  public TokenUuid: string;

  constructor(token: AccessToken) {
    super();
    this.TokenUuid = token.Uuid;
  }
}
```

`packages/rbac-http-token/src/events/AccessTokenCreated.ts`:

```ts
import { Event } from '@spinajs/queue';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenCreated extends AccessTokenEvent {}
```

`packages/rbac-http-token/src/events/AccessTokenDeleted.ts`:

```ts
import { Event } from '@spinajs/queue';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenDeleted extends AccessTokenEvent {}
```

`packages/rbac-http-token/src/events/AccessTokenRoleGranted.ts`:

```ts
import { Event } from '@spinajs/queue';
import { AccessToken } from '../models/AccessToken.js';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenRoleGranted extends AccessTokenEvent {
  constructor(token: AccessToken, public Role: string) {
    super(token);
  }
}
```

`packages/rbac-http-token/src/events/AccessTokenRoleRevoked.ts`:

```ts
import { Event } from '@spinajs/queue';
import { AccessToken } from '../models/AccessToken.js';
import { AccessTokenEvent } from './AccessTokenEvent.js';

@Event()
export class AccessTokenRoleRevoked extends AccessTokenEvent {
  constructor(token: AccessToken, public Role: string) {
    super(token);
  }
}
```

`packages/rbac-http-token/src/events/index.ts`:

```ts
export * from './AccessTokenEvent.js';
export * from './AccessTokenCreated.js';
export * from './AccessTokenDeleted.js';
export * from './AccessTokenRoleGranted.js';
export * from './AccessTokenRoleRevoked.js';
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './events/index.js';
```

- [ ] **Step 2: Verify compile**

```powershell
cd packages/rbac-http-token
npx tsc -b tsconfig.mjs.json
```

Expected: exit 0. (Events are exercised through action tests in Task 5 — no standalone test.)

- [ ] **Step 3: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): access token queue events"
```

---

### Task 5: Actions — create / delete / grantRole / revokeRole

**Files:**
- Create: `packages/rbac-http-token/src/actions.ts`
- Test: `packages/rbac-http-token/test/actions-crud.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `AccessToken`, `AccessTokenGenerationProvider`, events; `_user` resolution comes from `@spinajs/rbac` actions (`_get_user` is not exported — use the exported `getUser`-equivalent: resolve owner with `User.where(...)` locally, see `_owner()` helper below); `_chain`, `_check_arg`, `_trim`, `_non_empty`, `_non_nil`, `_max_length` from `@spinajs/util`; `_ev` from `@spinajs/queue`; `_service` from `@spinajs/configuration`.
- Produces (exact signatures used by middleware, controller, CLI in later tasks):
  - `enum E_CODES { E_TOKEN_NOT_FOUND, E_TOKEN_EXPIRED, E_TOKEN_OWNER_INVALID, E_TOKEN_ROLE_NOT_ALLOWED }`
  - `createToken(user: User | number | string, name: string, roles: string[], expiresAt: DateTime | null): Promise<{ Token: AccessToken; Plaintext: string }>`
  - `deleteToken(token: AccessToken | string): Promise<void>`
  - `grantTokenRole(token: AccessToken | string, role: string): Promise<AccessToken>`
  - `revokeTokenRole(token: AccessToken | string, role: string): Promise<AccessToken>`
  - `_token(token: AccessToken | string): () => Promise<AccessToken>` (uuid resolver helper, exported for reuse)

- [ ] **Step 1: Write failing tests**

`packages/rbac-http-token/test/actions-crud.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { create } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../src/actions.js';
import '../src/generator.js';

describe('access token actions - crud', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(DbTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  it('creates token for user, returns plaintext once, stores only hash', async () => {
    const { User: owner } = await create('c1@spinajs.com', 'c1', 'password123', ['user', 'admin']);

    const { Token, Plaintext } = await createToken(owner, 'ci token', ['user'], null);

    expect(Plaintext).to.match(/^spt_/);
    expect(Token.Uuid).to.be.a('string');
    expect(Token.Roles).to.deep.equal(['user']);
    expect(Token.ExpiresAt).to.be.null;

    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Token).to.have.length(64);
    expect(row.Token).to.not.contain(Plaintext);
    expect(row.user_id).to.equal(owner.Id);
  });

  it('accepts expiration date', async () => {
    const { User: owner } = await create('c2@spinajs.com', 'c2', 'password123', ['user']);
    const expires = DateTime.now().plus({ days: 7 });

    const { Token } = await createToken(owner, 'temp', ['user'], expires);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.ExpiresAt?.toISODate()).to.equal(expires.toISODate());
  });

  it('rejects roles the owner does not hold', async () => {
    const { User: owner } = await create('c3@spinajs.com', 'c3', 'password123', ['user']);
    await expect(createToken(owner, 'bad', ['admin'], null)).to.be.rejected;
  });

  it('resolves owner by uuid string', async () => {
    const { User: owner } = await create('c4@spinajs.com', 'c4', 'password123', ['user']);
    const { Token } = await createToken(owner.Uuid, 'by uuid', ['user'], null);
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.user_id).to.equal(owner.Id);
  });

  it('deletes token by uuid', async () => {
    const { User: owner } = await create('c5@spinajs.com', 'c5', 'password123', ['user']);
    const { Token } = await createToken(owner, 'to delete', ['user'], null);

    await deleteToken(Token.Uuid);
    const row = await AccessToken.where('Uuid', Token.Uuid).first();
    expect(row).to.be.undefined;
  });

  it('grants and revokes role on token, only owner-held roles grantable', async () => {
    const { User: owner } = await create('c6@spinajs.com', 'c6', 'password123', ['user', 'admin']);
    const { Token } = await createToken(owner, 'roles', ['user'], null);

    const granted = await grantTokenRole(Token.Uuid, 'admin');
    expect(granted.Roles).to.have.members(['user', 'admin']);

    const revoked = await revokeTokenRole(Token.Uuid, 'user');
    expect(revoked.Roles).to.deep.equal(['admin']);

    await expect(grantTokenRole(Token.Uuid, 'system')).to.be.rejected;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/actions-crud.test.ts
```

Expected: FAIL — `Cannot find module '../src/actions.js'`.

- [ ] **Step 3: Write implementation**

`packages/rbac-http-token/src/actions.ts`:

```ts
import _ from 'lodash';
import { DateTime } from 'luxon';
import { User } from '@spinajs/rbac';
import { _chain, _check_arg, _tap, _trim, _non_empty, _non_nil, _max_length } from '@spinajs/util';
import { _service } from '@spinajs/configuration';
import { _ev } from '@spinajs/queue';
import { ErrorCode } from '@spinajs/exceptions';
import { Constructor } from '@spinajs/di';

import { AccessToken } from './models/AccessToken.js';
import { AccessTokenGenerationProvider } from './interfaces.js';
import { AccessTokenCreated, AccessTokenDeleted, AccessTokenEvent, AccessTokenRoleGranted, AccessTokenRoleRevoked } from './events/index.js';

export enum E_CODES {
  E_TOKEN_NOT_FOUND,
  E_TOKEN_EXPIRED,
  E_TOKEN_OWNER_INVALID,
  E_TOKEN_ROLE_NOT_ALLOWED,
}

/**
 * Resolves an AccessToken from an instance or its uuid.
 */
export function _token(token: AccessToken | string) {
  if (_.isString(token)) {
    return () => AccessToken.where('Uuid', token).firstOrFail();
  }
  return () => Promise.resolve(token);
}

/**
 * Resolves the owning user by instance, numeric id or uuid, with metadata
 * populated ( needed for IsBanned checks downstream ).
 */
export function _owner(user: User | number | string) {
  if (_.isString(user)) {
    return () => User.where('Uuid', user).populate('Metadata').firstOrFail();
  }
  if (_.isNumber(user)) {
    return () => User.where('Id', user).populate('Metadata').firstOrFail();
  }
  return () => Promise.resolve(user);
}

function _token_ev(event: Constructor<AccessTokenEvent>, ...args: any[]) {
  return async (t: AccessToken) => {
    await _ev(new event(t, ...args))();
    return t;
  };
}

/**
 * Ensures every role in `roles` is currently held by `owner`.
 * A token must never carry a role its owner does not have.
 */
function _assert_roles_subset(owner: User, roles: string[]) {
  const missing = roles.filter((r) => !owner.Role.includes(r));
  if (missing.length !== 0) {
    throw new ErrorCode(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED, `Owner does not hold role(s): ${missing.join(', ')}`, { roles: missing });
  }
}

/**
 * Creates a new access token for a user.
 *
 * Roles must be a non-empty subset of the owner's current roles. `expiresAt`
 * null means the token never expires. The plaintext is returned once and
 * never persisted - only its hash is stored.
 */
export async function createToken(user: User | number | string, name: string, roles: string[], expiresAt: DateTime | null): Promise<{ Token: AccessToken; Plaintext: string }> {
  name = _check_arg(_trim(), _non_empty(), _max_length(128))(name, 'name');
  roles = _check_arg(_non_nil(), _non_empty())(roles, 'roles');

  const generator = await _service<AccessTokenGenerationProvider>('rbac.token.generation', AccessTokenGenerationProvider)();
  const generated = await generator.generate();

  return _chain(
    _owner(user),
    _tap(async (u: User) => _assert_roles_subset(u, roles)),
    async (u: User) => {
      const token = new AccessToken({
        Name: name,
        Token: generated.Hash,
        Roles: _.uniq(roles),
        ExpiresAt: expiresAt,
        user_id: u.Id,
      });
      await token.insert();
      return token;
    },
    _token_ev(AccessTokenCreated),
    (t: AccessToken) => ({ Token: t, Plaintext: generated.Plaintext }),
  );
}

/**
 * Permanently deletes ( revokes ) a token.
 */
export async function deleteToken(token: AccessToken | string): Promise<void> {
  return _chain(
    _token(token),
    _tap((t: AccessToken) => t.destroy()),
    _token_ev(AccessTokenDeleted),
    () => undefined,
  );
}

/**
 * Adds a role to a token. The role must be held by the token owner.
 */
export async function grantTokenRole(token: AccessToken | string, role: string): Promise<AccessToken> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _token(token),
    _tap(async (t: AccessToken) => {
      const owner = await _owner(t.user_id)();
      _assert_roles_subset(owner, [role]);
      t.Roles = _.uniq([...t.Roles, role]);
      await t.update();
    }),
    _token_ev(AccessTokenRoleGranted, role),
  );
}

/**
 * Removes a role from a token.
 */
export async function revokeTokenRole(token: AccessToken | string, role: string): Promise<AccessToken> {
  role = _check_arg(_trim(), _non_empty())(role, 'role');

  return _chain(
    _token(token),
    _tap(async (t: AccessToken) => {
      t.Roles = t.Roles.filter((r) => r !== role);
      await t.update();
    }),
    _token_ev(AccessTokenRoleRevoked, role),
  );
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './actions.js';
```

NOTE: verify the exact exported names from `@spinajs/util` (`_non_nil`, `_max_length`) against `packages/util/src` if compile fails — adjust imports, do not reimplement.

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/actions-crud.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): create/delete/grant/revoke token actions"
```

---

### Task 6: Actions — validateToken + deleteExpiredTokens

**Files:**
- Modify: `packages/rbac-http-token/src/actions.ts`
- Test: `packages/rbac-http-token/test/actions-validate.test.ts`

**Interfaces:**
- Consumes: Task 5 helpers, `AccessTokenGenerationProvider.hash`, `User` scopes (`isActiveUser` not used — explicit checks so we can report codes), `ban` action from `@spinajs/rbac` for the ban test.
- Produces:
  - `interface ITokenValidationResult { User: User; Token: AccessToken; EffectiveRoles: string[]; }`
  - `validateToken(plaintext: string): Promise<ITokenValidationResult>` — throws `ErrorCode(E_CODES.E_TOKEN_NOT_FOUND)` on unknown hash, `E_TOKEN_EXPIRED`, `E_TOKEN_OWNER_INVALID` (owner inactive / soft-deleted / banned). `EffectiveRoles = Token.Roles ∩ User.Role`; empty intersection throws `E_TOKEN_ROLE_NOT_ALLOWED`.
  - `deleteExpiredTokens(): Promise<number>` — hard-deletes rows with `ExpiresAt <= now`, returns count.
  - `touchToken(token: AccessToken, intervalSeconds: number): Promise<void>` — sets `LastUsedAt` if null or older than interval.

- [ ] **Step 1: Write failing tests**

`packages/rbac-http-token/test/actions-validate.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { create, deactivate, ban } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken, validateToken, deleteExpiredTokens, revokeTokenRole } from '../src/actions.js';
import '../src/generator.js';

describe('access token actions - validate & cleanup', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(DbTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  async function activeUser(mail: string, login: string, roles: string[]) {
    const { User: u } = await create(mail, login, 'password123', roles);
    const { activate } = await import('@spinajs/rbac');
    await activate(u.Id);
    return u;
  }

  it('validates a good token and returns effective roles', async () => {
    const owner = await activeUser('v1@spinajs.com', 'v1', ['user', 'admin']);
    const { Plaintext } = await createToken(owner, 'good', ['user'], null);

    const result = await validateToken(Plaintext);
    expect(result.User.Id).to.equal(owner.Id);
    expect(result.EffectiveRoles).to.deep.equal(['user']);
  });

  it('rejects unknown token', async () => {
    await expect(validateToken('spt_does-not-exist')).to.be.rejected;
  });

  it('rejects expired token', async () => {
    const owner = await activeUser('v2@spinajs.com', 'v2', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'expired', ['user'], DateTime.now().plus({ minutes: 5 }));

    // move expiry into the past directly in db
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    await expect(validateToken(Plaintext)).to.be.rejected;
  });

  it('infinite token (null expiry) validates', async () => {
    const owner = await activeUser('v3@spinajs.com', 'v3', ['user']);
    const { Plaintext } = await createToken(owner, 'infinite', ['user'], null);
    await expect(validateToken(Plaintext)).to.be.fulfilled;
  });

  it('rejects token of deactivated owner', async () => {
    const owner = await activeUser('v4@spinajs.com', 'v4', ['user']);
    const { Plaintext } = await createToken(owner, 'inactive owner', ['user'], null);
    await deactivate(owner.Id);
    await expect(validateToken(Plaintext)).to.be.rejected;
  });

  it('rejects token of banned owner', async () => {
    const owner = await activeUser('v5@spinajs.com', 'v5', ['user']);
    const { Plaintext } = await createToken(owner, 'banned owner', ['user'], null);
    await ban(owner.Id, 'test', 3600);
    await expect(validateToken(Plaintext)).to.be.rejected;
  });

  it('effective roles shrink when user loses a role', async () => {
    const owner = await activeUser('v6@spinajs.com', 'v6', ['user', 'admin']);
    const { Plaintext } = await createToken(owner, 'shrink', ['user', 'admin'], null);

    const { revoke } = await import('@spinajs/rbac');
    await revoke(owner.Id, 'admin');

    const result = await validateToken(Plaintext);
    expect(result.EffectiveRoles).to.deep.equal(['user']);
  });

  it('rejects when intersection is empty', async () => {
    const owner = await activeUser('v7@spinajs.com', 'v7', ['user']);
    const { Token, Plaintext } = await createToken(owner, 'empty intersection', ['user'], null);
    await revokeTokenRole(Token.Uuid, 'user');
    await expect(validateToken(Plaintext)).to.be.rejected;
  });

  it('deleteExpiredTokens removes only expired rows', async () => {
    const owner = await activeUser('v8@spinajs.com', 'v8', ['user']);
    const { Token: live } = await createToken(owner, 'live', ['user'], null);
    const { Token: dead } = await createToken(owner, 'dead', ['user'], DateTime.now().plus({ minutes: 5 }));

    const row = await AccessToken.where('Uuid', dead.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const count = await deleteExpiredTokens();
    expect(count).to.be.gte(1);
    expect(await AccessToken.where('Uuid', live.Uuid).first()).to.not.be.undefined;
    expect(await AccessToken.where('Uuid', dead.Uuid).first()).to.be.undefined;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/actions-validate.test.ts
```

Expected: FAIL — `validateToken` / `deleteExpiredTokens` not exported.

- [ ] **Step 3: Write implementation**

Append to `packages/rbac-http-token/src/actions.ts`:

```ts
export interface ITokenValidationResult {
  User: User;
  Token: AccessToken;
  /**
   * Token roles that the owner still holds. Permission checks run with these.
   */
  EffectiveRoles: string[];
}

/**
 * Validates a presented plaintext token.
 *
 * Checks, in order: token exists (by hash), token not expired, owner active /
 * not soft-deleted / not banned, effective role intersection non-empty.
 * Throws ErrorCode with E_CODES on every failure path.
 */
export async function validateToken(plaintext: string): Promise<ITokenValidationResult> {
  plaintext = _check_arg(_trim(), _non_empty())(plaintext, 'plaintext');

  const generator = await _service<AccessTokenGenerationProvider>('rbac.token.generation', AccessTokenGenerationProvider)();
  const hash = generator.hash(plaintext);

  const token = await AccessToken.where('Token', hash).first();
  if (!token) {
    throw new ErrorCode(E_CODES.E_TOKEN_NOT_FOUND, 'Access token not found');
  }

  if (token.IsExpired) {
    throw new ErrorCode(E_CODES.E_TOKEN_EXPIRED, 'Access token expired', { token: token.Uuid });
  }

  const owner = await User.where('Id', token.user_id).populate('Metadata').first();
  if (!owner || !owner.IsActive || owner.DeletedAt || owner.IsBanned) {
    throw new ErrorCode(E_CODES.E_TOKEN_OWNER_INVALID, 'Access token owner is not allowed to authenticate', { token: token.Uuid });
  }

  const effective = token.Roles.filter((r) => owner.Role.includes(r));
  if (effective.length === 0) {
    throw new ErrorCode(E_CODES.E_TOKEN_ROLE_NOT_ALLOWED, 'Access token has no effective roles', { token: token.Uuid });
  }

  return { User: owner, Token: token, EffectiveRoles: effective };
}

/**
 * Deletes every token whose expiration has passed. Returns deleted count.
 * Intended for cyclic execution from a worker ( see rbac:token-delete-expired ).
 */
export async function deleteExpiredTokens(): Promise<number> {
  const expired = await AccessToken.where('ExpiresAt', '<=', DateTime.now()).whereNotNull('ExpiresAt');
  const count = expired.length;
  for (const t of expired) {
    await t.destroy();
  }
  return count;
}

/**
 * Updates LastUsedAt, throttled: writes only when the stamp is null or older
 * than `intervalSeconds`. Callers may fire-and-forget.
 */
export async function touchToken(token: AccessToken, intervalSeconds: number): Promise<void> {
  const now = DateTime.now();
  if (token.LastUsedAt && token.LastUsedAt > now.minus({ seconds: intervalSeconds })) {
    return;
  }
  token.LastUsedAt = now;
  await token.update();
}
```

NOTE: if `AccessToken.where(...).whereNotNull(...)` await-collection syntax differs, mirror how rbac queries lists (e.g. `await AccessToken.where(...)` returns array via thenable builder). Check `packages/orm` query builder if compile/tests fail.

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/actions-validate.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Run whole suite, commit**

```powershell
npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): validateToken, deleteExpiredTokens, touchToken"
```

---

### Task 7: Explicit Order on RbacMiddleware (cross-package fix)

**Files:**
- Modify: `packages/rbac-http/src/middlewares.ts` (class `RbacMiddleware`)

**Interfaces:**
- Consumes: `ServerMiddleware.Order` sorting in `packages/http/src/server.ts:115` (`a.Order - b.Order`, ascending; lower runs first in `before()`).
- Produces: `RbacMiddleware.Order === 0`, guaranteed to sort deterministically against `TokenAuthMiddleware.Order === 1` (Task 8). Without this, `Order` is `undefined` and the comparator returns `NaN` — ordering between the two middlewares would be unspecified.

- [ ] **Step 1: Add Order in constructor**

In `packages/rbac-http/src/middlewares.ts`, add to `RbacMiddleware`:

```ts
  public constructor() {
    super();
    // Session restore must run before any middleware that depends on
    // req.storage.User ( e.g. rbac-http-token's TokenAuthMiddleware, Order 1 ).
    // Sorting is `a.Order - b.Order`; an unset Order is undefined and makes the
    // comparator return NaN, leaving relative order unspecified.
    this.Order = 0;
  }
```

- [ ] **Step 2: Run rbac-http tests**

```powershell
cd packages/rbac-http
npx ts-mocha -p tsconfig.json test/rbac-middleware.test.ts
npx ts-mocha -p tsconfig.json test/descriptor-inheritance.test.ts
```

Expected: PASS (same counts as before the change).

- [ ] **Step 3: Rebuild rbac-http (dependents test against compiled lib)**

```powershell
npm run build
```

Expected: exit 0, `lib/` refreshed.

- [ ] **Step 4: Commit**

```powershell
git add packages/rbac-http/src/middlewares.ts
git commit -m "fix(rbac-http): explicit Order 0 on RbacMiddleware for deterministic middleware sorting"
```

---

### Task 8: TokenAuthMiddleware

**Files:**
- Create: `packages/rbac-http-token/src/middlewares.ts`
- Test: `packages/rbac-http-token/test/middleware.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `validateToken`, `touchToken` (Task 6), `ServerMiddleware` from `@spinajs/http`, config keys `rbac.token.headerName` (default `x-api-key`), `rbac.token.lastUsedUpdateInterval` (default 60).
- Produces: `@Injectable(ServerMiddleware) class TokenAuthMiddleware extends ServerMiddleware` with `Order = 1`. Behaviour contract for policies (Task 9):
  - Request WITH valid token and no session ⇒ `req.storage.User` set (Role = EffectiveRoles), `req.storage.ActiveRole = EffectiveRoles[0]`, `req.storage.TokenAuth = { Uuid }`, response header `Cache-Control: no-store`.
  - Request with session already authenticated ⇒ untouched (session wins; a request cannot mix both).
  - Missing header ⇒ untouched.
  - Invalid/expired token ⇒ stays guest, `TokenAuth` unset, warn logged with token uuid where known — **never throws**, policies reject later.

- [ ] **Step 1: Write failing tests**

`packages/rbac-http-token/test/middleware.test.ts` — direct-construction pattern from `packages/rbac-http/test/rbac-middleware.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { create, activate } from '@spinajs/rbac';

import { DbTestConfiguration } from './db-common.js';
import { createToken } from '../src/actions.js';
import { TokenAuthMiddleware } from '../src/middlewares.js';
import '../src/generator.js';

const makeReqRes = (headers: Record<string, string>, storage: any = {}) => {
  const req: any = {
    headers,
    storage,
    get: (name: string) => headers[name.toLowerCase()],
  };
  const res: any = { setHeader: sinon.spy() };
  const next = sinon.spy();
  return { req, res, next };
};

describe('TokenAuthMiddleware', function () {
  this.timeout(15000);

  let middleware: TokenAuthMiddleware;

  before(async () => {
    DI.register(DbTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  beforeEach(() => {
    middleware = new TokenAuthMiddleware();
    Object.defineProperty(middleware, 'HeaderName', { value: 'x-api-key', writable: true });
    Object.defineProperty(middleware, 'LastUsedUpdateInterval', { value: 60, writable: true });
  });

  after(async () => {
    DI.clearCache();
  });

  async function tokenFor(mail: string, login: string) {
    const { User: owner } = await create(mail, login, 'password123', ['user']);
    await activate(owner.Id);
    return { owner, ...(await createToken(owner, 'mw token', ['user'], null)) };
  }

  it('authenticates a valid Bearer token', async () => {
    const { owner, Plaintext, Token } = await tokenFor('m1@spinajs.com', 'm1');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);

    expect(req.storage.User).to.not.be.undefined;
    expect(req.storage.User.Id).to.equal(owner.Id);
    expect(req.storage.User.Role).to.deep.equal(['user']);
    expect(req.storage.ActiveRole).to.equal('user');
    expect(req.storage.TokenAuth).to.deep.equal({ Uuid: Token.Uuid });
    sinon.assert.calledWith(res.setHeader, 'Cache-Control', 'no-store');
    sinon.assert.calledOnce(next);
  });

  it('authenticates via fallback header', async () => {
    const { Plaintext } = await tokenFor('m2@spinajs.com', 'm2');
    const { req, res, next } = makeReqRes({ 'x-api-key': Plaintext });

    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.not.be.undefined;
    sinon.assert.calledOnce(next);
  });

  it('leaves request untouched without token header', async () => {
    const { req, res, next } = makeReqRes({});
    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.be.undefined;
    expect(req.storage.User).to.be.undefined;
    sinon.assert.notCalled(res.setHeader);
    sinon.assert.calledOnce(next);
  });

  it('stays guest on invalid token, does not throw', async () => {
    const { req, res, next } = makeReqRes({ authorization: 'Bearer spt_invalid' });
    await middleware.before()(req, res, next);

    expect(req.storage.TokenAuth).to.be.undefined;
    expect(req.storage.User).to.be.undefined;
    sinon.assert.calledOnce(next);
    expect(next.firstCall.args.length).to.equal(0);
  });

  it('does not override an existing session user', async () => {
    const { Plaintext } = await tokenFor('m3@spinajs.com', 'm3');
    const sessionUser = { Id: 999, Role: ['admin'] };
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` }, { User: sessionUser, Session: { SessionId: 's' } });

    await middleware.before()(req, res, next);

    expect(req.storage.User).to.equal(sessionUser);
    expect(req.storage.TokenAuth).to.be.undefined;
  });

  it('updates LastUsedAt on successful auth', async () => {
    const { Plaintext, Token } = await tokenFor('m4@spinajs.com', 'm4');
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${Plaintext}` });

    await middleware.before()(req, res, next);
    // touch is fire-and-forget - give it a tick
    await new Promise((r) => setTimeout(r, 50));

    const { AccessToken } = await import('../src/models/AccessToken.js');
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.LastUsedAt).to.not.be.null;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/middleware.test.ts
```

Expected: FAIL — `Cannot find module '../src/middlewares.js'`.

- [ ] **Step 3: Write implementation**

`packages/rbac-http-token/src/middlewares.ts`:

```ts
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Request as sRequest, ServerMiddleware } from '@spinajs/http';

import { validateToken, touchToken } from './actions.js';
import './interfaces.js';

/**
 * Authenticates requests carrying an access token in `Authorization: Bearer`
 * or the configured fallback header. Runs AFTER RbacMiddleware ( Order 0 )
 * so a session, when present, always wins - a request cannot mix both.
 *
 * On success `req.storage.User` carries the owner with Role narrowed to the
 * token's effective roles, so every downstream permission check ( RbacPolicy
 * helpers, orm rbac query middleware, ownership ) works unchanged.
 *
 * Never throws: an invalid token leaves the request as guest and lets the
 * route's policy produce the rejection.
 */
@Injectable(ServerMiddleware)
export class TokenAuthMiddleware extends ServerMiddleware {
  @Logger('rbac-http-token')
  protected Log: Log;

  @Config('rbac.token.headerName', 'x-api-key')
  protected HeaderName: string;

  @Config('rbac.token.lastUsedUpdateInterval', 60)
  protected LastUsedUpdateInterval: number;

  constructor() {
    super();
    // After RbacMiddleware ( Order 0 ): session auth takes precedence.
    this.Order = 1;
  }

  public before(): (req: sRequest, res: express.Response, next: express.NextFunction) => void {
    return async (req: sRequest, res: express.Response, next: express.NextFunction) => {
      try {
        // Session user already authenticated - tokens do not apply.
        if (req.storage?.Session) {
          return next();
        }

        const plaintext = this.extract(req);
        if (!plaintext) {
          return next();
        }

        let result;
        try {
          result = await validateToken(plaintext);
        } catch (err) {
          // Deliberately vague towards the client; specific in the log.
          this.Log.warn(`Access token rejected: ${(err as Error).message}`, { Ip: (req as any).ip });
          return next();
        }

        // Narrowed role list is what makes the whole rbac stack token-aware.
        result.User.Role = result.EffectiveRoles;

        req.storage.User = result.User;
        req.storage.ActiveRole = result.EffectiveRoles[0];
        req.storage.TokenAuth = { Uuid: result.Token.Uuid };

        // Token-authenticated responses must never land in a shared cache.
        res.setHeader('Cache-Control', 'no-store');

        // Fire-and-forget throttled usage stamp.
        void touchToken(result.Token, this.LastUsedUpdateInterval).catch((err) => this.Log.warn(`Failed to update token LastUsedAt: ${err.message}`, { Token: result.Token.Uuid }));

        next();
      } catch (err) {
        next(err);
      }
    };
  }

  public after(): null {
    return null;
  }

  /**
   * Bearer scheme first, configured fallback header second.
   */
  protected extract(req: sRequest): string | null {
    const auth = req.headers?.['authorization'] as string | undefined;
    if (auth?.startsWith('Bearer ')) {
      return auth.substring('Bearer '.length).trim() || null;
    }

    const fallback = req.headers?.[this.HeaderName.toLowerCase()] as string | undefined;
    return fallback?.trim() || null;
  }
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './middlewares.js';
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/middleware.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): TokenAuthMiddleware bearer/header authentication"
```

---

### Task 9: Policies — TokenPolicy + NoTokenAuthPolicy

**Files:**
- Create: `packages/rbac-http-token/src/policies/TokenPolicy.ts`
- Create: `packages/rbac-http-token/src/policies/NoTokenAuthPolicy.ts`
- Test: `packages/rbac-http-token/test/policies.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: `req.storage.TokenAuth` contract from Task 8; `BasePolicy` from `@spinajs/http`; `checkRoutePermission`, `ACL_CONTROLLER_DESCRIPTOR`/`IRbacDescriptor` from `@spinajs/rbac-http` (pattern: `packages/rbac-http/src/policies/RbacPolicy.ts`).
- Produces:
  - `class TokenPolicy extends BasePolicy` — rejects with `AuthenticationFailed` when `req.storage.TokenAuth` is unset; then enforces route `@Resource`/`@Permission` grants exactly like `RbacPolicy` (reusing `checkRoutePermission`). Routes with no descriptor ⇒ `ServerError`.
  - `class NoTokenAuthPolicy extends BasePolicy` — rejects with `Forbidden` when `req.storage.TokenAuth` IS set; passes otherwise. Defense-in-depth for the token management controller.

- [ ] **Step 1: Write failing tests**

`packages/rbac-http-token/test/policies.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import 'reflect-metadata';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AccessControl } from 'accesscontrol';

import { TokenPolicy } from '../src/policies/TokenPolicy.js';
import { NoTokenAuthPolicy } from '../src/policies/NoTokenAuthPolicy.js';

describe('token policies', function () {
  before(async () => {
    // Minimal AccessControl with a grant for resource user.tokens
    const ac = new AccessControl({
      user: { 'test.resource': { 'read:own': ['*'] } },
    });
    DI.register(ac).asValue('AccessControl');
  });

  after(() => {
    DI.clearCache();
  });

  const routeDescriptor = (resource: string, permission: string[]) => {
    // Mimics what @Resource/@Permission decorators put on the controller:
    // instance-level descriptor with per-route permission map.
    const instance = {};
    const { ACL_CONTROLLER_DESCRIPTOR } = require('@spinajs/rbac-http');
    Reflect.defineMetadata(ACL_CONTROLLER_DESCRIPTOR, { Resource: resource, Permission: permission, Routes: new Map() }, instance);
    return instance as any;
  };

  const action: any = { Method: 'testMethod' };

  it('TokenPolicy rejects request without token auth', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: {} };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.rejected;
  });

  it('TokenPolicy accepts token-authenticated request with matching grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['readOwn']))).to.be.fulfilled;
  });

  it('TokenPolicy rejects token-authenticated request without grant', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] }, ActiveRole: 'user' } };
    await expect(policy.execute(req, action, routeDescriptor('test.resource', ['updateAny']))).to.be.rejected;
  });

  it('TokenPolicy errors on route without rbac descriptor', async () => {
    const policy = new TokenPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' }, User: { Role: ['user'] } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejected;
  });

  it('NoTokenAuthPolicy rejects token-authenticated request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { TokenAuth: { Uuid: 'x' } } };
    await expect(policy.execute(req, action, {} as any)).to.be.rejected;
  });

  it('NoTokenAuthPolicy passes session request', async () => {
    const policy = new NoTokenAuthPolicy();
    const req: any = { storage: { User: {}, Session: {} } };
    await expect(policy.execute(req, action, {} as any)).to.be.fulfilled;
  });
});
```

NOTE: verify `ACL_CONTROLLER_DESCRIPTOR` is exported from `@spinajs/rbac-http` root (`packages/rbac-http/src/decorators.ts`); if not, import from `@spinajs/rbac-http` deep path used by `RbacPolicy` and adjust test import accordingly.

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/policies.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Write implementation**

`packages/rbac-http-token/src/policies/TokenPolicy.ts`:

```ts
import { BasePolicy, IController, IRoute, ServerError, Request as sRequest } from '@spinajs/http';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { ACL_CONTROLLER_DESCRIPTOR, IRbacDescriptor, checkRoutePermission } from '@spinajs/rbac-http';

/**
 * Route requires authentication with an access token AND the token's
 * effective roles must satisfy the route's @Resource/@Permission grants.
 *
 * Mirrors RbacPolicy's grant enforcement, but for token-authenticated
 * requests ( which carry no session ).
 */
export class TokenPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest, action: IRoute, instance: IController): Promise<void> {
    if (!req.storage || !req.storage.TokenAuth || !req.storage.User) {
      throw new AuthenticationFailed('access token required');
    }

    const descriptor: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance);
    if (!descriptor || !descriptor.Permission || descriptor.Permission.length === 0) {
      throw new ServerError('no route permission or resources assigned');
    }

    let permission = descriptor.Permission ?? [];
    if (descriptor.Routes.has(String(action.Method))) {
      permission = descriptor.Routes.get(String(action.Method))!.Permission ?? [];
    }

    if (!permission.some((p) => checkRoutePermission(req, descriptor.Resource, p)?.granted)) {
      const effective = req.storage.ActiveRole ?? req.storage.User.Role;
      throw new Forbidden(`token role(s) ${effective} do not have permission ${permission} for resource ${descriptor.Resource}`);
    }
  }
}
```

`packages/rbac-http-token/src/policies/NoTokenAuthPolicy.ts`:

```ts
import { BasePolicy, IController, IRoute, Request as sRequest } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';

/**
 * Rejects requests authenticated with an access token. Applied to the token
 * management API so a token can never be used to mint or manage tokens
 * ( no self-replication ). Session-authenticated requests pass through.
 */
export class NoTokenAuthPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: sRequest, _action: IRoute, _instance: IController): Promise<void> {
    if (req.storage?.TokenAuth) {
      throw new Forbidden('access tokens cannot be used on this route');
    }
  }
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './policies/TokenPolicy.js';
export * from './policies/NoTokenAuthPolicy.js';
```

If `RbacPolicy.ts` currently reads `ACL_CONTROLLER_DESCRIPTOR` from a relative path and `@spinajs/rbac-http`'s `index.ts` does not re-export it or `IRbacDescriptor`/`checkRoutePermission`: add the missing exports to `packages/rbac-http/src/index.ts`, rerun its build (`cd packages/rbac-http && npm run build`), and commit that separately as `fix(rbac-http): export acl descriptor symbols`.

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/policies.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): TokenPolicy and NoTokenAuthPolicy"
```

---

### Task 10: AccessTokenController + DTO

**Files:**
- Create: `packages/rbac-http-token/src/dto/create-token-dto.ts`
- Create: `packages/rbac-http-token/src/controllers/AccessTokenController.ts`
- Create: `packages/rbac-http-token/test/common.ts` (http server test harness)
- Test: `packages/rbac-http-token/test/controller.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: actions (Task 5/6), `NoTokenAuthPolicy` (Task 9), `RbacPolicy`, `@Resource`, `@Permission`, `@User` route arg from `@spinajs/rbac-http`; `BaseController`, `BasePath`, `Get/Post/Del/Put`, `Ok/NotFound/Forbidden`, `@Body`, `@Param`, `@Policy` from `@spinajs/http` (pattern: `packages/rbac-http-user/src/controllers/SessionsController.ts`).
- Produces HTTP API (session-only, resource `user.tokens`):
  - `GET user/tokens` (readOwn) → `Ok<AccessToken[]>` (dehydrated: Uuid, Name, Roles, ExpiresAt, CreatedAt, LastUsedAt)
  - `POST user/tokens` (createOwn) body `CreateTokenDto { Name: string; Roles: string[]; ExpiresAt?: string | null }` → `Ok<{ Token: <dehydrated>; Plaintext: string }>`
  - `DELETE user/tokens/:uuid` (deleteOwn) → `Ok` | `NotFound`
  - `PUT user/tokens/:uuid/roles/:role` (updateOwn) → `Ok` | `NotFound`
  - `DELETE user/tokens/:uuid/roles/:role` (updateOwn) → `Ok` | `NotFound`

- [ ] **Step 1: Write DTO**

`packages/rbac-http-token/src/dto/create-token-dto.ts`:

```ts
import { Schema } from '@spinajs/validation';

export const CreateTokenDtoSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Create access token DTO',
  type: 'object',
  properties: {
    Name: { type: 'string', minLength: 1, maxLength: 128, description: 'Human readable token label' },
    Roles: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Roles allowed on the token, must be subset of own roles' },
    ExpiresAt: { type: ['string', 'null'], format: 'date-time', description: 'ISO expiration instant; null or omitted = never expires' },
  },
  required: ['Name', 'Roles'],
};

@Schema(CreateTokenDtoSchema)
export class CreateTokenDto {
  public Name: string;
  public Roles: string[];
  public ExpiresAt?: string | null;

  constructor(data: any) {
    Object.assign(this, data);
  }
}
```

- [ ] **Step 2: Write controller**

`packages/rbac-http-token/src/controllers/AccessTokenController.ts`:

```ts
import { BaseController, BasePath, Body, Del, Get, NotFound, Ok, Param, Policy, Post, Put } from '@spinajs/http';
import { User as UserModel } from '@spinajs/rbac';
import { Permission, Resource, User, RbacPolicy } from '@spinajs/rbac-http';
import { DateTime } from 'luxon';

import { AccessToken } from '../models/AccessToken.js';
import { createToken, deleteToken, grantTokenRole, revokeTokenRole } from '../actions.js';
import { CreateTokenDto } from '../dto/create-token-dto.js';
import { NoTokenAuthPolicy } from '../policies/NoTokenAuthPolicy.js';

/**
 * Self-service management of own access tokens.
 *
 * Session authentication is required and token authentication is explicitly
 * rejected: an access token must never be able to mint another token.
 * Every query is constrained by the calling user's id - a foreign uuid is
 * simply not found.
 *
 * @tags AccessTokens
 */
@BasePath('user')
@Resource('user.tokens')
@Policy(NoTokenAuthPolicy)
@Policy(RbacPolicy)
export class AccessTokenController extends BaseController {
  /**
   * List own access tokens. Hashes are never returned.
   */
  @Get('tokens')
  @Permission(['readOwn'])
  public async list(@User() user: UserModel): Promise<Ok<unknown>> {
    const tokens = await AccessToken.where('user_id', user.Id);
    return new Ok(tokens.map((t) => t.toJSON()));
  }

  /**
   * Create a token. The plaintext appears in this response only and cannot
   * be retrieved again.
   */
  @Post('tokens')
  @Permission(['createOwn'])
  public async create(@User() user: UserModel, @Body() dto: CreateTokenDto): Promise<Ok<unknown>> {
    const expiresAt = dto.ExpiresAt ? DateTime.fromISO(dto.ExpiresAt) : null;
    const { Token, Plaintext } = await createToken(user, dto.Name, dto.Roles, expiresAt);

    return new Ok({ Token: Token.toJSON(), Plaintext }, { Headers: [{ Name: 'Cache-Control', Value: 'no-store' }] });
  }

  /**
   * Delete ( revoke ) an own token.
   */
  @Del('tokens/:uuid')
  @Permission(['deleteOwn'])
  public async delete(@User() user: UserModel, @Param() uuid: string): Promise<Ok | NotFound> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    await deleteToken(token);
    return new Ok();
  }

  /**
   * Grant a role to an own token. Role must be held by the caller.
   */
  @Put('tokens/:uuid/roles/:role')
  @Permission(['updateOwn'])
  public async grantRole(@User() user: UserModel, @Param() uuid: string, @Param() role: string): Promise<Ok<unknown> | NotFound> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    const updated = await grantTokenRole(token, role);
    return new Ok(updated.toJSON());
  }

  /**
   * Revoke a role from an own token.
   */
  @Del('tokens/:uuid/roles/:role')
  @Permission(['updateOwn'])
  public async revokeRole(@User() user: UserModel, @Param() uuid: string, @Param() role: string): Promise<Ok<unknown> | NotFound> {
    const token = await this.own(user, uuid);
    if (!token) {
      return new NotFound({ error: { code: 'E_TOKEN_NOT_FOUND', message: 'No such token' } });
    }

    const updated = await revokeTokenRole(token, role);
    return new Ok(updated.toJSON());
  }

  /**
   * Resolves a token by uuid WITHIN the caller's own tokens - the ownership
   * boundary of this whole controller.
   */
  protected own(user: UserModel, uuid: string): Promise<AccessToken | undefined> {
    return AccessToken.where({ Uuid: uuid, user_id: user.Id }).first();
  }
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './controllers/AccessTokenController.js';
export * from './dto/create-token-dto.js';
```

- [ ] **Step 3: Write http test harness**

`packages/rbac-http-token/test/common.ts` — merge of rbac-http-user's `common.ts` + `db-common.ts` config, plus a session helper:

```ts
import { DI } from '@spinajs/di';
import { Controllers, HttpServer } from '@spinajs/http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { SessionProvider, UserSession, User } from '@spinajs/rbac';
import * as cs from 'cookie-signature';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';
import cookieParser from 'cookie-parser';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export const COOKIE_SECRET = 'rbac-http-token-test-secret';

export function req() {
  return chai.request('http://localhost:8889/');
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
          migrations: [dir('./../src/migrations')],
          models: [dir('./../src/models')],
        },
      },
      http: {
        port: 8889,
        cookie: { secret: COOKIE_SECRET },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), cookieParser()],
        AcceptHeaders: 1,
      },
      rbac: {
        defaultRole: 'guest',
        enableGuestAccount: false,
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'test.resource': { 'read:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
            'test.resource': { 'read:own': ['*'] },
          },
        },
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: { secure: false },
        },
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          validation: { service: 'BasicPasswordValidationProvider', rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' } },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      },
      queue: {
        default: 'default-test-queue',
        connections: [{ service: 'BlackHoleQueueClient', name: 'default-test-queue' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

/**
 * Creates an authorized session for the user and returns the signed ssid
 * cookie value ready for a Cookie header.
 */
export async function sessionCookieFor(user: User): Promise<string> {
  const provider = await DI.resolve(SessionProvider);
  const session = new UserSession();
  session.UserId = user.Id;
  session.Data.set('User', user.Uuid);
  session.Data.set('Authorized', true);
  session.Data.set('ActiveRole', user.Role[0]);
  await provider.save(session);

  return `ssid=${encodeURIComponent(cs.sign(session.SessionId, COOKIE_SECRET))}`;
}

export function ctr() {
  return DI.get(Controllers);
}
```

NOTE: verify `MemorySessionStore` resolves via `DI.resolve(SessionProvider)` after configuration (check `packages/rbac/src/session.ts` for registration); adjust to `DI.resolve<SessionProvider>('rbac.session.service')`-style lookup only if the direct resolve fails.

- [ ] **Step 4: Write failing controller tests**

`packages/rbac-http-token/test/controller.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Controllers, HttpServer } from '@spinajs/http';
import '@spinajs/orm-sqlite';
import '@spinajs/rbac-http';
import { create, activate, User } from '@spinajs/rbac';

import { TestConfiguration, sessionCookieFor, req } from './common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/middlewares.js';

describe('AccessTokenController', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);
    server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    server.stop();
    DI.clearCache();
  });

  async function makeUser(mail: string, login: string, roles: string[] = ['user']) {
    const { User: u } = await create(mail, login, 'password123', roles);
    await activate(u.Id);
    return User.where('Id', u.Id).populate('Metadata').firstOrFail();
  }

  it('rejects anonymous access', async () => {
    const res = await req().get('user/tokens');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('creates a token and returns plaintext exactly once', async () => {
    const user = await makeUser('h1@spinajs.com', 'h1');
    const cookie = await sessionCookieFor(user);

    const res = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'my token', Roles: ['user'] });
    expect(res.status).to.equal(200);
    expect(res.body.Plaintext).to.match(/^spt_/);
    expect(res.body.Token.Uuid).to.be.a('string');
    expect(res.body.Token).to.not.have.property('Token');

    const list = await req().get('user/tokens').set('Cookie', cookie);
    expect(list.status).to.equal(200);
    expect(list.body).to.have.length(1);
    expect(JSON.stringify(list.body)).to.not.contain(res.body.Plaintext);
  });

  it('rejects creating token with role caller does not hold', async () => {
    const user = await makeUser('h2@spinajs.com', 'h2');
    const cookie = await sessionCookieFor(user);

    const res = await req().post('user/tokens').set('Cookie', cookie).send({ Name: 'bad', Roles: ['admin'] });
    expect(res.status).to.be.oneOf([400, 403, 500]);
  });

  it('deletes own token, foreign uuid not found', async () => {
    const alice = await makeUser('h3@spinajs.com', 'h3');
    const bob = await makeUser('h4@spinajs.com', 'h4');
    const { Token: bobsToken } = await createToken(bob, 'bobs', ['user'], null);

    const aliceCookie = await sessionCookieFor(alice);

    const foreign = await req().delete(`user/tokens/${bobsToken.Uuid}`).set('Cookie', aliceCookie);
    expect(foreign.status).to.equal(404);

    const { Token: own } = await createToken(alice, 'own', ['user'], null);
    const deleted = await req().delete(`user/tokens/${own.Uuid}`).set('Cookie', aliceCookie);
    expect(deleted.status).to.equal(200);
    expect(await AccessToken.where('Uuid', own.Uuid).first()).to.be.undefined;
  });

  it('grants and revokes role on own token', async () => {
    const user = await makeUser('h5@spinajs.com', 'h5', ['user', 'admin']);
    const cookie = await sessionCookieFor(user);
    const { Token } = await createToken(user, 'roles', ['user'], null);

    const granted = await req().put(`user/tokens/${Token.Uuid}/roles/admin`).set('Cookie', cookie);
    expect(granted.status).to.equal(200);
    expect(granted.body.Roles).to.have.members(['user', 'admin']);

    const revoked = await req().delete(`user/tokens/${Token.Uuid}/roles/admin`).set('Cookie', cookie);
    expect(revoked.status).to.equal(200);
    expect(revoked.body.Roles).to.deep.equal(['user']);
  });

  it('a valid access token cannot manage tokens', async () => {
    const user = await makeUser('h6@spinajs.com', 'h6');
    const { Plaintext } = await createToken(user, 'self-replication attempt', ['user'], null);

    const res = await req().post('user/tokens').set('Authorization', `Bearer ${Plaintext}`).send({ Name: 'clone', Roles: ['user'] });
    expect(res.status).to.be.oneOf([401, 403]);
  });
});
```

- [ ] **Step 5: Run test to verify it fails, then passes**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/controller.test.ts
```

Expected first run (before Step 1-3 files): FAIL. After implementation: 6 passing.

Debug notes if failing:
- 404 on all routes: check `system.dirs.controllers` path and that `Controllers` resolved before server start.
- 401 despite cookie: `RbacMiddleware` needs `http.cookie.secret` config — present in harness; confirm cookie name `ssid`.
- `RbacPolicy` errors `no route permission`: verify `@Resource`/`@Permission` decorators register per-route (compare with a working controller in rbac-http-user).

- [ ] **Step 6: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): AccessTokenController with session-only self-service API"
```

---

### Task 11: TokenPolicy end-to-end route test

**Files:**
- Create: `packages/rbac-http-token/test/support/TestTokenController.ts` (test-only controller)
- Test: `packages/rbac-http-token/test/token-policy-e2e.test.ts`

**Interfaces:**
- Consumes: full stack — `TokenAuthMiddleware`, `TokenPolicy`, harness from Task 10.
- Produces: proof the advertised usage `@Policy(TokenPolicy)` + `@Resource` + `@Permission` secures a route for token holders.

- [ ] **Step 1: Write test-only controller**

`packages/rbac-http-token/test/support/TestTokenController.ts`:

```ts
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { Permission, Resource } from '@spinajs/rbac-http';

import { TokenPolicy } from '../../src/policies/TokenPolicy.js';

/**
 * Test-only route secured the way consumers are expected to secure theirs.
 */
@BasePath('token-protected')
@Resource('test.resource')
@Policy(TokenPolicy)
export class TestTokenController extends BaseController {
  @Get('data')
  @Permission(['readOwn'])
  public async data(): Promise<Ok<{ ok: boolean }>> {
    return new Ok({ ok: true });
  }
}
```

Register the folder in the harness: in `test/common.ts` extend `system.dirs.controllers` to `[dir('./../src/controllers'), dir('./support')]`.

- [ ] **Step 2: Write failing e2e test**

`packages/rbac-http-token/test/token-policy-e2e.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { Controllers, HttpServer } from '@spinajs/http';
import '@spinajs/orm-sqlite';
import '@spinajs/rbac-http';
import { create, activate, User } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { TestConfiguration, req } from './common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import '../src/generator.js';
import '../src/middlewares.js';

describe('TokenPolicy e2e', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);
    server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    server.stop();
    DI.clearCache();
  });

  async function makeUserToken(mail: string, login: string, roles: string[], tokenRoles: string[], expires: DateTime | null = null) {
    const { User: u } = await create(mail, login, 'password123', roles);
    await activate(u.Id);
    const owner = await User.where('Id', u.Id).populate('Metadata').firstOrFail();
    return { owner, ...(await createToken(owner, 'e2e', tokenRoles, expires)) };
  }

  it('valid bearer token reaches the route', async () => {
    const { Plaintext } = await makeUserToken('e1@spinajs.com', 'e1', ['user'], ['user']);
    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.be.true;
  });

  it('valid fallback-header token reaches the route', async () => {
    const { Plaintext } = await makeUserToken('e2@spinajs.com', 'e2', ['user'], ['user']);
    const res = await req().get('token-protected/data').set('x-api-key', Plaintext);
    expect(res.status).to.equal(200);
  });

  it('anonymous request is rejected', async () => {
    const res = await req().get('token-protected/data');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('expired token is rejected', async () => {
    const { Token, Plaintext } = await makeUserToken('e3@spinajs.com', 'e3', ['user'], ['user'], DateTime.now().plus({ minutes: 5 }));
    const row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 5 });
    await row.update();

    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.be.oneOf([401, 403]);
  });

  it('token without required grant is rejected', async () => {
    // guest role has no grant on test.resource
    const { owner, Plaintext } = await makeUserToken('e4@spinajs.com', 'e4', ['user', 'guest'], ['guest']);
    const res = await req().get('token-protected/data').set('Authorization', `Bearer ${Plaintext}`);
    expect(res.status).to.equal(403);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/token-policy-e2e.test.ts
```

Expected: 5 passing. (First run fails while support controller missing — that is the failing checkpoint.)

- [ ] **Step 4: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "test(rbac-http-token): TokenPolicy end-to-end route coverage"
```

---

### Task 12: CLI commands

**Files:**
- Create: `packages/rbac-http-token/src/cli/CreateToken.ts`
- Create: `packages/rbac-http-token/src/cli/DeleteToken.ts`
- Create: `packages/rbac-http-token/src/cli/GrantTokenRole.ts`
- Create: `packages/rbac-http-token/src/cli/RevokeTokenRole.ts`
- Create: `packages/rbac-http-token/src/cli/DeleteExpiredTokens.ts`
- Test: `packages/rbac-http-token/test/cli.test.ts`
- Modify: `packages/rbac-http-token/src/index.ts`

**Interfaces:**
- Consumes: actions; `@Command`/`@Argument`/`@Option`, `CliCommand` from `@spinajs/cli` (pattern: `packages/rbac/src/cli/GrantUserRole.ts`, `CreateUser.ts`).
- Produces commands:
  - `rbac:token-create <userIdOrUuid>` with `-n, --name <name>` (required), `-r, --roles <roles>` comma separated (required), `-e, --expires <iso>` (optional; absent = infinite). Prints plaintext once via `Log.success`.
  - `rbac:token-delete <uuid>`
  - `rbac:token-grant <uuid> <role>` / `rbac:token-revoke <uuid> <role>`
  - `rbac:token-delete-expired` — prints deleted count; worker-friendly cyclic cleanup.

- [ ] **Step 1: Write failing tests**

`packages/rbac-http-token/test/cli.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { create, activate } from '@spinajs/rbac';
import { DateTime } from 'luxon';

import { DbTestConfiguration } from './db-common.js';
import { AccessToken } from '../src/models/AccessToken.js';
import { createToken } from '../src/actions.js';
import { CreateToken } from '../src/cli/CreateToken.js';
import { DeleteToken } from '../src/cli/DeleteToken.js';
import { GrantTokenRole } from '../src/cli/GrantTokenRole.js';
import { RevokeTokenRole } from '../src/cli/RevokeTokenRole.js';
import { DeleteExpiredTokens } from '../src/cli/DeleteExpiredTokens.js';
import '../src/generator.js';

describe('access token cli commands', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(DbTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(async () => {
    DI.clearCache();
  });

  async function makeUser(mail: string, login: string, roles: string[] = ['user']) {
    const { User: u } = await create(mail, login, 'password123', roles);
    await activate(u.Id);
    return u;
  }

  it('rbac:token-create creates token for user', async () => {
    const user = await makeUser('cli1@spinajs.com', 'cli1');
    const cmd = await DI.resolve(CreateToken);

    await cmd.execute(user.Uuid, { name: 'cli token', roles: 'user', expires: undefined });

    const tokens = await AccessToken.where('user_id', user.Id);
    expect(tokens).to.have.length(1);
    expect(tokens[0].Name).to.equal('cli token');
    expect(tokens[0].ExpiresAt).to.be.null;
  });

  it('rbac:token-create honors --expires', async () => {
    const user = await makeUser('cli2@spinajs.com', 'cli2');
    const cmd = await DI.resolve(CreateToken);
    const iso = DateTime.now().plus({ days: 1 }).toISO()!;

    await cmd.execute(user.Uuid, { name: 'expiring', roles: 'user', expires: iso });

    const tokens = await AccessToken.where('user_id', user.Id);
    expect(tokens[0].ExpiresAt).to.not.be.null;
  });

  it('rbac:token-delete removes token', async () => {
    const user = await makeUser('cli3@spinajs.com', 'cli3');
    const { Token } = await createToken(user, 'doomed', ['user'], null);

    const cmd = await DI.resolve(DeleteToken);
    await cmd.execute(Token.Uuid);

    expect(await AccessToken.where('Uuid', Token.Uuid).first()).to.be.undefined;
  });

  it('rbac:token-grant / rbac:token-revoke mutate roles', async () => {
    const user = await makeUser('cli4@spinajs.com', 'cli4', ['user', 'admin']);
    const { Token } = await createToken(user, 'roles', ['user'], null);

    await (await DI.resolve(GrantTokenRole)).execute(Token.Uuid, 'admin');
    let row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Roles).to.have.members(['user', 'admin']);

    await (await DI.resolve(RevokeTokenRole)).execute(Token.Uuid, 'admin');
    row = await AccessToken.where('Uuid', Token.Uuid).firstOrFail();
    expect(row.Roles).to.deep.equal(['user']);
  });

  it('rbac:token-delete-expired removes only expired tokens', async () => {
    const user = await makeUser('cli5@spinajs.com', 'cli5');
    const { Token: live } = await createToken(user, 'live', ['user'], null);
    const { Token: dead } = await createToken(user, 'dead', ['user'], DateTime.now().plus({ minutes: 1 }));

    const row = await AccessToken.where('Uuid', dead.Uuid).firstOrFail();
    row.ExpiresAt = DateTime.now().minus({ minutes: 1 });
    await row.update();

    await (await DI.resolve(DeleteExpiredTokens)).execute();

    expect(await AccessToken.where('Uuid', live.Uuid).first()).to.not.be.undefined;
    expect(await AccessToken.where('Uuid', dead.Uuid).first()).to.be.undefined;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd packages/rbac-http-token
npx ts-mocha -p tsconfig.json test/cli.test.ts
```

Expected: FAIL — cli modules missing.

- [ ] **Step 3: Write implementations**

`packages/rbac-http-token/src/cli/CreateToken.ts`:

```ts
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DateTime } from 'luxon';

import { createToken } from '../actions.js';

interface ICreateTokenOptions {
  name: string;
  roles: string;
  expires?: string;
}

@Command('rbac:token-create', 'Creates an access token for a user')
@Argument('userIdOrUuid', true, 'numeric id or uuid of the owner')
@Option('-n, --name <name>', true, 'token label')
@Option('-r, --roles <roles>', true, 'token roles, comma separated, must be subset of owner roles')
@Option('-e, --expires <expires>', false, 'ISO expiration instant; omit for a token that never expires')
export class CreateToken extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(userIdOrUuid: string, options: ICreateTokenOptions): Promise<void> {
    try {
      const expiresAt = options.expires ? DateTime.fromISO(options.expires) : null;
      if (expiresAt && !expiresAt.isValid) {
        this.Log.error(`Invalid --expires value: ${options.expires}`);
        return;
      }

      const roles = options.roles.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
      const owner = /^\d+$/.test(userIdOrUuid) ? parseInt(userIdOrUuid, 10) : userIdOrUuid;

      const { Token, Plaintext } = await createToken(owner, options.name, roles, expiresAt);

      this.Log.success(`Token created: ${Token.Uuid}`);
      // The single moment the plaintext exists outside the caller's hands.
      this.Log.success(`Token ( copy now, it will not be shown again ): ${Plaintext}`);
    } catch (e) {
      this.Log.error(`Error while creating token: ${(e as Error).message}`);
    }
  }
}
```

`packages/rbac-http-token/src/cli/DeleteToken.ts`:

```ts
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { deleteToken } from '../actions.js';

@Command('rbac:token-delete', 'Deletes ( revokes ) an access token')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(uuid: string): Promise<void> {
    try {
      await deleteToken(uuid);
      this.Log.success(`Token ${uuid} deleted`);
    } catch (e) {
      this.Log.error(`Error while deleting token ${uuid}: ${(e as Error).message}`);
    }
  }
}
```

`packages/rbac-http-token/src/cli/GrantTokenRole.ts`:

```ts
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { grantTokenRole } from '../actions.js';

@Command('rbac:token-grant', 'Grants a role to an access token')
@Argument('uuid', true, 'token uuid')
@Argument('role', true, 'role to grant, must be held by token owner')
export class GrantTokenRole extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(uuid: string, role: string): Promise<void> {
    try {
      await grantTokenRole(uuid, role);
      this.Log.success(`Role ${role} granted to token ${uuid}`);
    } catch (e) {
      this.Log.error(`Error while granting role ${role} to token ${uuid}: ${(e as Error).message}`);
    }
  }
}
```

`packages/rbac-http-token/src/cli/RevokeTokenRole.ts`:

```ts
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { revokeTokenRole } from '../actions.js';

@Command('rbac:token-revoke', 'Revokes a role from an access token')
@Argument('uuid', true, 'token uuid')
@Argument('role', true, 'role to revoke')
export class RevokeTokenRole extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(uuid: string, role: string): Promise<void> {
    try {
      await revokeTokenRole(uuid, role);
      this.Log.success(`Role ${role} revoked from token ${uuid}`);
    } catch (e) {
      this.Log.error(`Error while revoking role ${role} from token ${uuid}: ${(e as Error).message}`);
    }
  }
}
```

`packages/rbac-http-token/src/cli/DeleteExpiredTokens.ts`:

```ts
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';

import { deleteExpiredTokens } from '../actions.js';

/**
 * Intended for cyclic execution from a worker process
 * ( eg. cron / task scheduler ) to keep the token table clean.
 */
@Command('rbac:token-delete-expired', 'Deletes all expired access tokens')
export class DeleteExpiredTokens extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(): Promise<void> {
    try {
      const count = await deleteExpiredTokens();
      this.Log.success(`Deleted ${count} expired token(s)`);
    } catch (e) {
      this.Log.error(`Error while deleting expired tokens: ${(e as Error).message}`);
    }
  }
}
```

Add to `packages/rbac-http-token/src/index.ts`:

```ts
export * from './cli/CreateToken.js';
export * from './cli/DeleteToken.js';
export * from './cli/GrantTokenRole.js';
export * from './cli/RevokeTokenRole.js';
export * from './cli/DeleteExpiredTokens.js';
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npx ts-mocha -p tsconfig.json test/cli.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): cli commands for token lifecycle and expired cleanup"
```

---

### Task 13: Package config + final wiring

**Files:**
- Create: `packages/rbac-http-token/src/config/rbac-http-token.ts`
- Modify: `packages/rbac-http-token/src/index.ts` (final export order)

**Interfaces:**
- Consumes: config auto-discovery (`node_modules/@spinajs/*/lib/{mjs,cjs}/config`, see `packages/configuration/src/sources.ts:99`) — the file ships defaults to every consuming app.
- Produces: default config exposing `rbac.token.*`, cli dir registration, event routing, and default grants for `user.tokens`.

- [ ] **Step 1: Write config**

`packages/rbac-http-token/src/config/rbac-http-token.ts` (dir resolution pattern from `packages/rbac/src/config/rbac.ts`):

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'rbac-http-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'rbac-http-token', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const rbacHttpToken = {
  system: {
    dirs: {
      cli: [...dir('cli')],
      controllers: [...dir('controllers')],
      migrations: [...dir('migrations')],
      models: [...dir('models')],
    },
  },
  queue: {
    routing: {
      AccessTokenCreated: { connection: 'rbac-user-empty-queue' },
      AccessTokenDeleted: { connection: 'rbac-user-empty-queue' },
      AccessTokenRoleGranted: { connection: 'rbac-user-empty-queue' },
      AccessTokenRoleRevoked: { connection: 'rbac-user-empty-queue' },
    },
  },
  rbac: {
    token: {
      /**
       * Token generation algorithm. Swap for your own implementation of
       * AccessTokenGenerationProvider registered under this name.
       */
      generation: {
        service: 'SecureRandomTokenProvider',
      },

      /**
       * Stable plaintext prefix - lets secret scanners recognise leaked tokens.
       */
      prefix: 'spt_',

      /**
       * Random bytes per token ( 32 = 256 bit entropy ).
       */
      length: 32,

      /**
       * Fallback header checked when no `Authorization: Bearer` is present.
       */
      headerName: 'x-api-key',

      /**
       * Seconds between LastUsedAt writes for a busy token.
       */
      lastUsedUpdateInterval: 60,
    },
    grants: {
      user: {
        'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
      },
      'admin.users': {
        'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      },
    },
  },
};

export default rbacHttpToken;
```

- [ ] **Step 2: Final index.ts**

`packages/rbac-http-token/src/index.ts` full content:

```ts
import './generator.js';
import './middlewares.js';

export * from './interfaces.js';
export * from './models/AccessToken.js';
export * from './migrations/RbacHttpTokenInitial_2026_08_11_01_00_00.js';
export * from './generator.js';
export * from './events/index.js';
export * from './actions.js';
export * from './middlewares.js';
export * from './policies/TokenPolicy.js';
export * from './policies/NoTokenAuthPolicy.js';
export * from './controllers/AccessTokenController.js';
export * from './dto/create-token-dto.js';
export * from './cli/CreateToken.js';
export * from './cli/DeleteToken.js';
export * from './cli/GrantTokenRole.js';
export * from './cli/RevokeTokenRole.js';
export * from './cli/DeleteExpiredTokens.js';
```

- [ ] **Step 3: Full package verification**

```powershell
cd packages/rbac-http-token
npm run compile && npm run compile:cjs
npx ts-mocha -p tsconfig.json "test/**/*.test.ts"
```

Expected: both builds exit 0; full suite passing (model 3 + generator 3 + crud 6 + validate 9 + middleware 6 + policies 6 + controller 6 + e2e 5 + cli 5 = 49). If cross-file DI leakage appears on the glob run (known pattern in this repo — see http/fs packages), verify per-file and note counts.

- [ ] **Step 4: Lint**

```powershell
npm run lint
```

Expected: exit 0 (auto-fixes applied).

- [ ] **Step 5: Commit**

```powershell
git add packages/rbac-http-token
git commit -m "feat(rbac-http-token): default config, grants, final exports"
```

---

### Task 14: README + final review

**Files:**
- Modify: `packages/rbac-http-token/README.md`

- [ ] **Step 1: Write README**

`packages/rbac-http-token/README.md`:

```markdown
# @spinajs/rbac-http-token

Personal access tokens (PAT) for spinajs HTTP routes. Opaque `spt_...` tokens,
stored hashed (SHA-256), assigned to users, with rbac role intersection and
optional expiration.

## Securing a route

    import { TokenPolicy } from '@spinajs/rbac-http-token';
    import { Permission, Resource } from '@spinajs/rbac-http';

    @BasePath('api')
    @Resource('my.resource')
    @Policy(TokenPolicy)
    export class ApiController extends BaseController {
      @Get('data')
      @Permission(['readOwn'])
      public async data() { ... }
    }

Clients authenticate with `Authorization: Bearer spt_...` or the configured
fallback header (`x-api-key` by default).

## Token semantics

- Effective roles at request time = token roles ∩ owner's current roles.
- Owner deactivated / banned / deleted => all their tokens stop working.
- `ExpiresAt` null => token never expires.
- Plaintext shown exactly once at creation; only hash stored.
- Session-authenticated requests ignore tokens; tokens cannot manage tokens.

## HTTP API (session auth required)

| Route | Description |
|---|---|
| `GET user/tokens` | list own tokens |
| `POST user/tokens` | create (`{ Name, Roles, ExpiresAt? }`), returns plaintext once |
| `DELETE user/tokens/:uuid` | revoke |
| `PUT user/tokens/:uuid/roles/:role` | grant role |
| `DELETE user/tokens/:uuid/roles/:role` | revoke role |

## CLI

    rbac:token-create <userIdOrUuid> -n <name> -r <roles> [-e <iso>]
    rbac:token-delete <uuid>
    rbac:token-grant <uuid> <role>
    rbac:token-revoke <uuid> <role>
    rbac:token-delete-expired   # run cyclically from a worker

## Configuration

See `src/config/rbac-http-token.ts` - `rbac.token.*` (generator service,
prefix, length, fallback header, LastUsedAt throttle).
```

- [ ] **Step 2: Full monorepo sanity for touched sibling**

```powershell
cd packages/rbac-http
npx ts-mocha -p tsconfig.json test/rbac-middleware.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add packages/rbac-http-token/README.md
git commit -m "docs(rbac-http-token): package README"
```

---

## Self-Review Notes (already applied)

- Spec coverage: token policy (T9, T11), DB persistence + add/delete (T2, T5), user assignment multi-token (T2 FK, tests), expiry/infinite (T2, T6), rbac role respect grant/revoke (T5, T6 intersection), controller API (T10), expired-cleanup CLI for worker (T12), rbac/http feature reuse (RbacPolicy machinery via narrowed roles, T8), injectable generator via config (T3), CLI create/remove with users+roles (T12), @Policy-secured routes (T9/T11), tests throughout, security considerations (hash-only, one-time plaintext, no-store, no self-replication, owner-state gating).
- Known verify-points flagged inline: `@spinajs/util` helper names (T5), thenable query list syntax (T6), `ACL_CONTROLLER_DESCRIPTOR` export from rbac-http root (T9), `SessionProvider` direct resolve (T10). Each has a fallback instruction.
- Type consistency: `createToken/deleteToken/grantTokenRole/revokeTokenRole/validateToken/deleteExpiredTokens/touchToken` signatures identical across T5/T6/T8/T10/T12; `ITokenAuthInfo { Uuid }` consistent T2/T8/T9.
```
