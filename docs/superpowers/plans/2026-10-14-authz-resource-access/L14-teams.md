# Lane L14: teams

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints, frozen contracts and names table bind every step here. The design is `docs/plans/2026-10-14-teams-design.md` (cited as *teams §n*).

**Goal:** A new package `@spinajs/teams`: teams and groups as `@AccessResource` models, the role/permission/policy config fragment of teams §4-5, `TeamService`, `GroupService` and `InvitationService` built only on authz-v3 primitives (`AuthzAdmin`, subject sets, the membership closure, `authz_resource_ancestor`, scope attributes).

**Architecture:** Models `Team` and `Group` declare `@Parent` links, so authz-orm keeps the scope tree; membership is `authz_assignment` rows plus L6's closure. Services check their own permission first (`AuthzService.assert`), write the model row through the ORM, then run one `AuthzAdmin` batch. People-facing writes (members, roles, transfers, cross-team grants, invitations' dry run) run **as the actor**, so `DefaultAdminGuard` (escalation, ladder ranks, `keepHolders`) judges them; structural writes (owner bootstrap, set links, the `archived` scope attribute, invitation accept) run **as `SYSTEM`** after the service's own check. The fragment maps `authz.admin.permissions` for `team`/`group` scopes to the teams permissions, so AuthzAdmin's own permission check passes for team admins without `authz:*` permissions. `DbAuthzAdminBackend` refuses a caller transaction, so a model write and its batch are two steps; a failed batch undoes the model write.

**Tech Stack:** TypeScript (node16 ESM + CJS), `@spinajs/orm` + `orm-sqlite` (tests), `@spinajs/authz`, `@spinajs/authz-rbac`, `@spinajs/authz-orm`, `@spinajs/authz-abac` (tests and the archived policy), `@spinajs/email`, luxon, mocha + chai.

**Depends on:** every resource-access lane merged (L0-L13), in particular: L3 (`AccessResource`, `Parent`, `reparent`, delete clean-up), L4 (`.accessible()`, `.within(ref)`), L6 (`subjectKeyOf`, `MembershipStore`, set-in-set closure, Task 7 set links via `assignment.grant`), L8 (nested sets in checks, `authz.admin.guard.keepHolders`), L10 (ABAC `scope.*` checks), L9 (the e2e stack this lane's test stack mirrors).

**Blocks:** L15 (`@spinajs/teams-http`).

## Global Constraints

- Everything in `00-overview.md` "Global Constraints" applies (English only, comments only where a reader asks "why?", `Object.freeze` on returned values, conventional commits after every task).
- Versions: `@spinajs/authz*` and `@spinajs/teams` `3.0.0-alpha.0`, `@spinajs/users`-family `3.0.0-alpha.0`, other `@spinajs/*` `2.0.549`, `luxon` `^3.6.1`.
- New package scaffold: copy `packages/authz-abac` (`.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.mocharc.json`, `.npmignore`, `.prettierrc`, `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `typedoc.json`), add it to root `tsconfig.build.json`, `tsconfig.build.cjs.json` and root `package.json` `dependencies` as `"@spinajs/teams": "file:packages/teams"`.
- `packages/teams/src/api.ts` is snapshotted: any change needs `npm run build` (root), `node scripts/api-snapshot.mjs --update` and an RFC `docs/plans/authz-v3-rfc/RA14-<n>.md` in the same commit.
- Tests: `test/<area>/<name>.test.ts`. One file: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/<path>.test.ts`. Package: `cd packages/teams && npm test`.
- All test files share one booted stack per mocha process (`test/support/db.ts`, `test/support/stack.ts`); tests never call `testHost.resetHost()` and use fresh ids (`randomUUID`, `person()`), so cases do not see each other's rows.
- Teams' model I/O inside services runs as `SYSTEM` (`asSystem`), after the service checked the actor; lists for an actor use `.accessible()` under `runWithPrincipal(actor, …)`.
- Error types: bad input `InvalidArgument(message, field)`, unknown or deleted rows `ResourceNotFound`, duplicate slugs `ResourceDuplicated`, refused checks `AccessDenied` (from `assert`), refused admin batches `AuthzAdminFailure(code, message, field)` (the first failed result, rethrown), invitation refusals `InvitationRefused(code)`, misconfiguration `AuthzConfigError`.

## Decisions made in this lane

1. **Who runs a batch.** Actor: `addTeamMember`, `removeTeamMember`, `setTeamRole`, `transferOwnership`, `grant`, `revoke`, `addGroupMember`/`removeGroupMember` of a principal, invitation creation (dry run). `SYSTEM` (after the service's `assert`): `createTeam` (the actor holds nothing on the new team yet), set links on create and move, `archived` attribute writes, set members of groups (`{ group }`/`{ team }` added to a group), invitation accept (teams §8). The guard runs only for non-`SYSTEM` actors (`admin.ts` L276), so `keepHolders` protects actor batches; `SYSTEM` batches never remove an owner except through purge, which forgets the scope.
2. **`authz.admin.permissions` mapping** (shipped in the fragment): `assignment.*` at `team` → `team:members.manage`, at `group` → `team:roles.manage`; `set.*` at `team` → `team:members.manage`, at `group` → `group:members.manage`; `scope.setAttributes` at `team` → `team:archive`; `list.assignments` at `team` → `team:read`, at `group` → `group:read`. AuthzAdmin checks the mapped permission for `SYSTEM` too, and the engine refuses a permission checked on a type it does not declare, so every mapped permission declares the scope type.
3. **Set links** use `assignment.grant { subject: { set }, role, scope }` (teams §3 as corrected; `set.addMember` takes principals only). A top-level group links into `team:T#team.member`, a nested group into its parent group's set, a sub-team into its parent's set when `teams.membership.subTeamsInParent` (read at link time). A move revokes **every** role of the moved set at its old target (`assignment.revokeWhere` without `role`) and grants the new link.
4. **No escalation through invitations** is an `AuthzAdmin.execute(actor, [the accept command for a probe user], { dryRun: true })`: the admin permission check and the guard's escalation and ladder-rank checks refuse what the actor could not grant itself. `AuthzService.covers` (teams §8) compares two principals, not a principal and a role, so it cannot answer this.
5. **`setTeamRole`** is `assignment.revokeWhere { scope, subject }` then `assignment.grant { role }` in one actor batch: no dependency on ladder names, and the guard sees the removal (ranks, `keepHolders`). `transferOwnership(actor, teamId, to, { keepAs = 'team.admin' })` is one actor batch: grant `team.owner` to `to`, grant `keepAs` to the actor (skipped when null or already held directly at the team), revoke the actor's `team.owner`. Both grants come before the revoke because the guard runs per command: `keepHolders` needs the new owner first, and escalation judges the actor's own `keepAs` grant while the actor is still owner.
6. **Archive and delete.** Two deny policies (teams §5, split so archiving never blocks deleting): `teams.archived.write` denies `*:create` and `*:update` on `team` and `group`; `teams.archived.delete` denies `*:delete` on `group` only. Both are limited to types with a team ancestor: `scope.team.*` on a resource without one is indeterminate in checks (`compiler.ts` L360 throws). So an archived team is deleted without unarchiving. Soft delete sets `deleted_at` and the `archived` attribute (writes freeze during the grace); `restoreTeam` needs `team:delete` and puts the attribute back to `archived_at !== null`; `purgeTeam(actor, id)` needs `team:delete`; `purgeDue(now)` is the system operation a scheduler calls.
7. **Groups are hard-deleted** (no `deleted_at` in teams §6); a group with sub-groups is refused.
8. **`TeamPurged`** is published to every `AuthzEventSink` of the teams domain (`Array.chainOf(AuthzEventSink)`): it is already the after-commit channel apps subscribe to for `RoleAssigned`/`RoleRevoked`; a sink failure is logged, the purge stays.
9. **Verified email** comes from a port, `VerifiedEmailSource`, with **no default implementation** (`Principal` carries no verified email): until the app registers one, creating or accepting an email invitation fails with `InvalidOperation` naming the port. Link invitations need none.
10. **Invitation mails** go through a port, `InvitationMailer` (default `EmailInvitationMailer` over `EmailService.send`, sent at once with `redact`, never queued: the token is a secret, as authn-local's `PasswordMailer` treats reset links). `resend` rotates the token (only its hash is stored).
11. **Domain:** teams use the domain `authz.orm.domain` names (default `root`), the one authz-orm keeps their ancestors in. Teams models use connection `default`.
12. **Create order: authz batch first, row second.** `DbAuthzAdminBackend` refuses a caller transaction, so the two cannot commit together. `createTeam`/`createGroup` run the `SYSTEM` batch (owner, `archived` attribute, set links) for the new id first (a scope needs no row), then insert the row; when the insert fails, a second batch revokes what the first wrote. A crash between the two leaves assignments at a scope with no resource (inert: no adapter resolves it; `authz:ancestors-verify`/`scope.forget` remove it), never a team without an owner. Moves, archive and delete keep "row first, undo the row when the batch fails" (they change existing rows whose authz data already exists).
13. **Ladder `team` has no `resourceTypes`** (verified: `packages/authz-rbac/src/model/ladder/ladders.ts` L128-132, `admin/common.ts` L82-84: a ladder without it applies everywhere), so team roles reach every resource type below a team, app types included.

## Files

| File | Responsibility | Task |
|---|---|---|
| `packages/teams/{.eslintignore,.eslintrc.cjs,.gitignore,.mocharc.json,.npmignore,.prettierrc,package.json,tsconfig.json,tsconfig.mjs.json,tsconfig.cjs.json,typedoc.json}` | scaffold | 1 |
| `packages/teams/src/api.ts` | frozen public contract (snapshotted) | 1 |
| `packages/teams/src/schema.ts` | `teams.*` config schema, defaults | 1 |
| `packages/teams/src/index.ts` | package root | 1, 2, 4, 5, 7, 9, 10 |
| `docs/plans/authz-v3-rfc/RA14-1.md`, `packages/teams/etc/teams.api.md`, `scripts/api-snapshot.json` | RFC and snapshot | 1 |
| `packages/teams/src/migrations/Teams_2026_10_14_00_00_00.ts` | `teams`, `groups` | 2 |
| `packages/teams/src/models/Team.ts`, `src/models/Group.ts` | models | 2 |
| `packages/teams/src/refs.ts`, `src/validate.ts`, `src/views.ts`, `src/host.ts`, `src/lookup.ts` | shared helpers | 2 |
| `packages/teams/src/config/teams.ts` | config fragment (roles, permissions, policy, admin mapping, keepHolders, scope attributes) | 3 |
| `packages/teams/src/subjects.ts`, `src/membership.ts` | subject mapping, `teamsOf` | 4 |
| `packages/teams/src/services/team-service.ts` | `DefaultTeamService` | 5, 6, 8 |
| `packages/teams/src/services/links.ts` | set link commands | 5 |
| `packages/teams/src/services/group-service.ts` | `DefaultGroupService` | 7 |
| `packages/teams/src/services/events.ts` | `publishTeamEvents` | 8 |
| `packages/teams/src/migrations/TeamsInvitations_2026_10_14_00_01_00.ts`, `src/models/TeamInvitation.ts` | invitation tables | 9 |
| `packages/teams/src/invitations/token.ts`, `src/invitations/mailer.ts`, `src/invitations/rows.ts`, `src/invitations/service.ts` | invitations | 9, 10 |
| `packages/teams/README.md` | package docs | 11 |
| `packages/teams/test/support/db.ts`, `test/support/project.ts`, `test/support/stack.ts`, `test/support/people.ts` | test stack (`project.ts`: an app type below a team) | 2, 3, 9 |

---

### Task 1: Package scaffold, `api.ts`, config schema

**Files:**
- Create: the scaffold files listed in the Files table, `packages/teams/src/api.ts`, `packages/teams/src/schema.ts`, `packages/teams/src/index.ts`, `packages/teams/README.md` (one line, Task 11 writes it), `docs/plans/authz-v3-rfc/RA14-1.md`
- Modify: `tsconfig.build.json`, `tsconfig.build.cjs.json`, `package.json` (root), `scripts/api-snapshot.json`
- Generate: `packages/teams/etc/teams.api.md`
- Test: `packages/teams/test/api.test.ts`, `packages/teams/test/schema.test.ts`

**Interfaces:**
- Produces (every later task and L15 code against these names):
  - constants `TEAM_TYPE = 'team'`, `GROUP_TYPE = 'group'`, `TEAM_MEMBER_ROLE = 'team.member'`, `TEAM_OWNER_ROLE = 'team.owner'`, `TEAM_ADMIN_ROLE = 'team.admin'`, `GROUP_MEMBER_ROLE = 'group.member'`, `TEAM_PURGED_EVENT = 'TeamPurged'`;
  - `TeamSubject = PrincipalRef | { group: string } | { team: string }`;
  - views `TeamView`, `GroupView`, `InvitationView`, `MemberEntry`, `PrincipalTeams`, `Paged<T>`, `Page`;
  - inputs `CreateTeamInput`, `UpdateTeamInput`, `CreateGroupInput`, `UpdateGroupInput`, `MoveGroupInput`, `CreateInvitationInput`, `AcceptedInvitation`, `InvitationMail`;
  - abstract classes `TeamService`, `GroupService`, `InvitationService`, `InvitationMailer`, `VerifiedEmailSource`; error `InvitationRefused` with the stable `code: InvitationRefusal` (one of `INVITATION_REFUSALS`); lists take `Page` and return `Paged<T>` (`{ items, total }`); `InvitationService.revoke`/`resend` take the `teamId`;
  - `TEAMS_CONFIGURATION_SCHEMA`, `TEAMS_DEFAULTS`, `INVITATION_SECRET_MIN_LENGTH = 32` (`src/schema.ts`, not snapshotted).

- [ ] **Step 1: Copy the scaffold**

```bash
mkdir -p packages/teams/src packages/teams/test
cd packages/authz-abac
cp .eslintignore .eslintrc.cjs .gitignore .mocharc.json .npmignore .prettierrc package.json tsconfig.json tsconfig.mjs.json tsconfig.cjs.json typedoc.json ../teams/
cd ../teams && ls -a
```

Expected: the eleven files above.

- [ ] **Step 2: `package.json`, tsconfigs, `.mocharc.json`**

Replace `packages/teams/package.json` with:

```json
{
  "name": "@spinajs/teams",
  "version": "3.0.0-alpha.0",
  "description": "Teams, groups and invitations for SpinaJS, built on authz-v3",
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
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=16.11"
  },
  "scripts": {
    "build": "npm run clean && npm run compile",
    "compile": "tsc -b tsconfig.mjs.json",
    "compile:cjs": "tsc -b tsconfig.cjs.json",
    "rimraf": "./node_modules/rimraf/bin.js",
    "clean": "rimraf lib/ && rimraf tsconfig.tsbuildinfo",
    "pretest": "npm run compile",
    "test": "ts-mocha -p tsconfig.json --timeout 60000",
    "coverage": "nyc npm run test",
    "build-docs": "rimraf docs && typedoc --options typedoc.json src/",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint -c .eslintrc.cjs --ext .ts src --fix",
    "preversion": "npm run lint",
    "version": "npm run format && git add -A src"
  },
  "files": [
    "lib/**/*"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/spinajs/main.git"
  },
  "keywords": [
    "spinajs",
    "authz",
    "teams"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/authz": "3.0.0-alpha.0",
    "@spinajs/authz-orm": "3.0.0-alpha.0",
    "@spinajs/authz-rbac": "3.0.0-alpha.0",
    "@spinajs/configuration": "2.0.549",
    "@spinajs/di": "2.0.549",
    "@spinajs/email": "2.0.549",
    "@spinajs/exceptions": "2.0.549",
    "@spinajs/log": "2.0.549",
    "@spinajs/orm": "2.0.549",
    "luxon": "^3.6.1"
  },
  "devDependencies": {
    "@spinajs/authz-abac": "3.0.0-alpha.0",
    "@spinajs/authz-testing": "3.0.0-alpha.0",
    "@spinajs/orm-sqlite": "2.0.549",
    "@types/luxon": "^3.4.2"
  }
}
```

(`@types/luxon`: use the version `packages/users/package.json` pins if it differs.)

`packages/teams/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*", "test/**/*"],
  "references": [{ "path": "../authz/tsconfig.json" }, { "path": "../authz-orm/tsconfig.json" }, { "path": "../authz-rbac/tsconfig.json" }, { "path": "../authz-abac/tsconfig.json" }, { "path": "../authz-testing/tsconfig.json" }, { "path": "../configuration/tsconfig.json" }, { "path": "../di/tsconfig.json" }, { "path": "../email/tsconfig.json" }, { "path": "../exceptions/tsconfig.json" }, { "path": "../log/tsconfig.json" }, { "path": "../orm/tsconfig.json" }]
}
```

`packages/teams/tsconfig.mjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/mjs",
    "module": "node16",
    "moduleResolution": "node16"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authz/tsconfig.mjs.json" }, { "path": "../authz-orm/tsconfig.mjs.json" }, { "path": "../authz-rbac/tsconfig.mjs.json" }, { "path": "../configuration/tsconfig.mjs.json" }, { "path": "../di/tsconfig.mjs.json" }, { "path": "../email/tsconfig.mjs.json" }, { "path": "../exceptions/tsconfig.mjs.json" }, { "path": "../log/tsconfig.mjs.json" }, { "path": "../orm/tsconfig.mjs.json" }]
}
```

`packages/teams/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authz/tsconfig.cjs.json" }, { "path": "../authz-orm/tsconfig.cjs.json" }, { "path": "../authz-rbac/tsconfig.cjs.json" }, { "path": "../configuration/tsconfig.cjs.json" }, { "path": "../di/tsconfig.cjs.json" }, { "path": "../email/tsconfig.cjs.json" }, { "path": "../exceptions/tsconfig.cjs.json" }, { "path": "../log/tsconfig.cjs.json" }, { "path": "../orm/tsconfig.cjs.json" }]
}
```

`.mocharc.json` stays as copied (`spec: test/**/*.test.ts`, the two node options). `README.md`:

```markdown
# @spinajs/teams

Teams, groups and invitations on authz-v3. See Task 11 of lane L14.
```

- [ ] **Step 3: Root build lists and dependency**

In `tsconfig.build.json`, after `{ "path": "packages/authz-convert/tsconfig.mjs.json" },` add:

```json
    { "path": "packages/teams/tsconfig.mjs.json" },
```

In `tsconfig.build.cjs.json`, after `{ "path": "./packages/authz-convert/tsconfig.cjs.json" },` add:

```json
    { "path": "./packages/teams/tsconfig.cjs.json" },
```

In root `package.json` `dependencies`, after `"@spinajs/authz-convert": "file:packages/authz-convert",` add:

```json
    "@spinajs/teams": "file:packages/teams",
```

In `scripts/api-snapshot.json` `packages`, after `"authz-fs": ["src/api.ts"],` add:

```json
    "teams": ["src/api.ts"],
```

Run: `npm install` (repo root)
Expected: no errors; `node_modules/@spinajs/teams` links to `packages/teams`.

- [ ] **Step 4: Write the failing tests**

`packages/teams/test/api.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { Forbidden } from '@spinajs/exceptions';

import * as teams from '../src/index.js';

const expect = chai.expect;

describe('teams api', () => {
  it('names the types, roles and event the package is built on', () => {
    expect(teams.TEAM_TYPE).to.equal('team');
    expect(teams.GROUP_TYPE).to.equal('group');
    expect(teams.TEAM_MEMBER_ROLE).to.equal('team.member');
    expect(teams.TEAM_OWNER_ROLE).to.equal('team.owner');
    expect(teams.TEAM_ADMIN_ROLE).to.equal('team.admin');
    expect(teams.GROUP_MEMBER_ROLE).to.equal('group.member');
    expect(teams.TEAM_PURGED_EVENT).to.equal('TeamPurged');
  });

  it('exports the service contracts as abstract DI tokens', () => {
    for (const token of [teams.TeamService, teams.GroupService, teams.InvitationService, teams.InvitationMailer, teams.VerifiedEmailSource]) {
      expect(token).to.be.a('function');
    }
  });

  it('InvitationRefused is a Forbidden carrying a stable, enumerable code', () => {
    const e = new teams.InvitationRefused('expired');
    expect(e).to.be.instanceOf(Forbidden);
    expect(e.code).to.equal('expired');
    expect(Object.keys(e)).to.include('code');
    expect(e.message).to.match(/expired/);
    expect(teams.INVITATION_REFUSALS).to.deep.equal(['unknown', 'revoked', 'expired', 'used_up', 'email_mismatch', 'not_a_user']);
  });
});
```

`packages/teams/test/schema.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';

import { TEAMS_CONFIGURATION_SCHEMA, TEAMS_DEFAULTS } from '../src/index.js';

const expect = chai.expect;

describe('teams configuration schema', () => {
  it('fills the defaults', async () => {
    const { child, configuration } = await bootConfiguration({ teams: { membership: {}, deletion: {}, invitations: {} } }, [TEAMS_CONFIGURATION_SCHEMA]);
    try {
      expect(configuration.get('teams.membership.subTeamsInParent')).to.equal(true);
      expect(configuration.get('teams.deletion.graceDays')).to.equal(30);
      expect(configuration.get('teams.invitations.defaultTtlHours')).to.equal(168);
      expect(configuration.get('teams.invitations.secret')).to.equal(undefined);
    } finally {
      await child.dispose();
    }
    expect(TEAMS_DEFAULTS).to.deep.equal({ subTeamsInParent: true, graceDays: 30, defaultTtlHours: 168, subject: 'You are invited to join a team' });
  });

  it('refuses a short secret, a negative grace and an unknown key', async () => {
    const paths = await violationPaths(bootConfiguration({ teams: { invitations: { secret: 'short' }, deletion: { graceDays: -1 }, membership: { subTeamsInParent: 'yes' } } }, [TEAMS_CONFIGURATION_SCHEMA]));
    expect(paths).to.include('teams.invitations.secret');
    expect(paths).to.include('teams.deletion.graceDays');
    expect(paths).to.include('teams.membership.subTeamsInParent');
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/api.test.ts test/schema.test.ts`
Expected: FAIL, `Cannot find module '../src/index.js'`.

- [ ] **Step 6: `src/api.ts`**

```ts
import type { Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Forbidden } from '@spinajs/exceptions';

export const TEAM_TYPE = 'team';
export const GROUP_TYPE = 'group';
export const TEAM_MEMBER_ROLE = 'team.member';
export const TEAM_OWNER_ROLE = 'team.owner';
export const TEAM_ADMIN_ROLE = 'team.admin';
export const GROUP_MEMBER_ROLE = 'group.member';
/** `AuthzEvent.type` of a purged team; `data`: `{ team, slug, teams, groups }` (ids removed, the team's own first). */
export const TEAM_PURGED_EVENT = 'TeamPurged';

/** A principal, every member of a group (`group:<id>#group.member`), or every member of a team (`team:<id>#team.member`). */
export type TeamSubject = PrincipalRef | { readonly group: string } | { readonly team: string };

export interface TeamView {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GroupView {
  readonly id: string;
  readonly teamId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTeamInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly parentId?: string | null;
  /** Who gets `team.owner`; default the actor. A SYSTEM caller must name one. */
  readonly owner?: PrincipalRef;
}

export interface UpdateTeamInput {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string | null;
}

export interface CreateGroupInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly parentId?: string | null;
}

export type UpdateGroupInput = UpdateTeamInput;

export interface MoveGroupInput {
  /** Default: the group's team. */
  readonly teamId?: string;
  readonly parentId: string | null;
}

/** One assignment at a team or group scope, its subject mapped back to a TeamSubject. */
export interface MemberEntry {
  readonly subject: TeamSubject;
  readonly role: string;
  readonly assignmentId: string;
  readonly expiresAt: Date | null;
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** The roles are those held at that exact scope, directly or through a set; caps and ceilings are not applied. */
export interface PrincipalTeams {
  readonly teams: readonly (TeamView & { readonly roles: readonly string[] })[];
  readonly groups: readonly (GroupView & { readonly roles: readonly string[] })[];
}

export abstract class TeamService {
  abstract createTeam(actor: Principal, input: CreateTeamInput): Promise<TeamView>;
  abstract getTeam(actor: Principal, id: string): Promise<TeamView>;
  /** Live teams the actor may `team:read`, by name; `parentId` null lists root teams. */
  abstract listTeams(actor: Principal, opts?: { readonly parentId?: string | null; readonly page?: Page }): Promise<Paged<TeamView>>;
  abstract updateTeam(actor: Principal, id: string, input: UpdateTeamInput): Promise<TeamView>;
  abstract moveTeam(actor: Principal, id: string, parentId: string | null): Promise<TeamView>;
  abstract archiveTeam(actor: Principal, id: string): Promise<TeamView>;
  abstract unarchiveTeam(actor: Principal, id: string): Promise<TeamView>;
  abstract deleteTeam(actor: Principal, id: string): Promise<void>;
  abstract restoreTeam(actor: Principal, id: string): Promise<TeamView>;
  /** Hard-deletes a soft-deleted team with its sub-teams, groups and invitations now; needs `team:delete`. */
  abstract purgeTeam(actor: Principal, id: string): Promise<readonly string[]>;
  /** System operation: purges every team deleted at least `teams.deletion.graceDays` before `now`; returns the purged team ids. */
  abstract purgeDue(now?: Date): Promise<readonly string[]>;
  abstract members(actor: Principal, teamId: string, page?: Page): Promise<Paged<MemberEntry>>;
  abstract addTeamMember(actor: Principal, teamId: string, subject: TeamSubject, role?: string): Promise<void>;
  abstract removeTeamMember(actor: Principal, teamId: string, subject: TeamSubject): Promise<void>;
  abstract setTeamRole(actor: Principal, teamId: string, subject: TeamSubject, role: string): Promise<void>;
  /** `keepAs` (default `team.admin`, null: nothing) is what the previous owner keeps at the team. */
  abstract transferOwnership(actor: Principal, teamId: string, to: PrincipalRef, opts?: { readonly keepAs?: string | null }): Promise<void>;
  abstract grant(actor: Principal, subject: TeamSubject, role: string, scope: ResourceRef): Promise<void>;
  abstract revoke(actor: Principal, subject: TeamSubject, role: string, scope: ResourceRef): Promise<void>;
  abstract teamsOf(principal: PrincipalRef): Promise<PrincipalTeams>;
}

export abstract class GroupService {
  abstract createGroup(actor: Principal, teamId: string, input: CreateGroupInput): Promise<GroupView>;
  abstract getGroup(actor: Principal, id: string): Promise<GroupView>;
  abstract listGroups(actor: Principal, teamId: string, page?: Page): Promise<Paged<GroupView>>;
  abstract updateGroup(actor: Principal, id: string, input: UpdateGroupInput): Promise<GroupView>;
  abstract moveGroup(actor: Principal, id: string, to: MoveGroupInput): Promise<GroupView>;
  abstract deleteGroup(actor: Principal, id: string): Promise<void>;
  abstract members(actor: Principal, groupId: string, page?: Page): Promise<Paged<MemberEntry>>;
  abstract addGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void>;
  abstract removeGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void>;
}

export interface InvitationView {
  readonly id: string;
  readonly teamId: string;
  readonly groupId: string | null;
  readonly role: string;
  readonly email: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastSentAt: Date | null;
}

export interface CreateInvitationInput {
  readonly teamId: string;
  /** Join this group of the team instead of the team directly. */
  readonly groupId?: string | null;
  readonly role: string;
  /** Mailed and bound to this verified address; absent: a shareable link. */
  readonly email?: string | null;
  /** Default 1 for an email invitation, unlimited for a link; null: unlimited until expiry. */
  readonly maxUses?: number | null;
  /** Default `teams.invitations.defaultTtlHours`. */
  readonly expiresInHours?: number;
}

export interface AcceptedInvitation {
  readonly invitationId: string;
  readonly teamId: string;
  readonly groupId: string | null;
  readonly role: string;
}

export abstract class InvitationService {
  /** The token is returned here only. */
  abstract create(actor: Principal, input: CreateInvitationInput): Promise<{ readonly invitation: InvitationView; readonly token: string }>;
  abstract list(actor: Principal, teamId: string, page?: Page): Promise<Paged<InvitationView>>;
  /** ResourceNotFound when the invitation belongs to another team. */
  abstract revoke(actor: Principal, teamId: string, id: string): Promise<void>;
  /** Mails a new token (the old one stops working); ResourceNotFound when the invitation belongs to another team. */
  abstract resend(actor: Principal, teamId: string, id: string): Promise<InvitationView>;
  abstract accept(principal: Principal, token: string): Promise<AcceptedInvitation>;
}

export interface InvitationMail {
  readonly to: string;
  readonly team: TeamView;
  readonly group: GroupView | null;
  readonly role: string;
  /** Secret: never queue, log or persist it. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly invitedBy: PrincipalRef;
}

export abstract class InvitationMailer {
  abstract send(mail: InvitationMail): Promise<void>;
}

/**
 * The address an email invitation is matched against; undefined when the principal has no verified one. No default:
 * email invitations are refused until the app registers one.
 */
export abstract class VerifiedEmailSource {
  abstract verifiedEmail(principal: Principal): Promise<string | undefined>;
}

/** Stable codes: HTTP layers map them (L15). */
export const INVITATION_REFUSALS = Object.freeze(['unknown', 'revoked', 'expired', 'used_up', 'email_mismatch', 'not_a_user'] as const);
export type InvitationRefusal = (typeof INVITATION_REFUSALS)[number];

/** `code` is one of INVITATION_REFUSALS and is part of the contract; the message is not. */
export class InvitationRefused extends Forbidden {
  constructor(
    readonly code: InvitationRefusal,
    message?: string,
  ) {
    super(message ?? `invitation refused: ${code}`);
    this.name = new.target.name;
  }
}
```

- [ ] **Step 7: `src/schema.ts` and `src/index.ts`**

`src/schema.ts`:

```ts
import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const INVITATION_SECRET_MIN_LENGTH = 32;

export const TEAMS_DEFAULTS = Object.freeze({ subTeamsInParent: true, graceDays: 30, defaultTtlHours: 168, subject: 'You are invited to join a team' });

const text = { type: 'string', minLength: 1 };
// propertyNames rejects a typo; additionalProperties: false would let removeAdditional drop it silently.
const closed = (properties: Record<string, unknown>) => ({ type: 'object', default: {}, properties, propertyNames: { enum: Object.keys(properties) } });

export const TEAMS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/teams.configuration.schema.json',
  $configurationModule: 'teams',
  description: 'Teams configuration (teams.*)',
  type: 'object',
  properties: {
    membership: closed({ subTeamsInParent: { type: 'boolean', default: TEAMS_DEFAULTS.subTeamsInParent } }),
    deletion: closed({ graceDays: { type: 'integer', minimum: 0, default: TEAMS_DEFAULTS.graceDays } }),
    invitations: closed({
      // No default: a guessable key would let invitation tokens be forged.
      secret: { type: 'string', minLength: INVITATION_SECRET_MIN_LENGTH },
      template: text,
      subject: { ...text, default: TEAMS_DEFAULTS.subject },
      url: text,
      connection: text,
      defaultTtlHours: { type: 'integer', minimum: 1, default: TEAMS_DEFAULTS.defaultTtlHours },
    }),
  },
};

registerConfigurationSchemaAtImport(TEAMS_CONFIGURATION_SCHEMA);
```

`src/index.ts`:

```ts
export * from './api.js';
export * from './schema.js';
```

- [ ] **Step 8: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/api.test.ts test/schema.test.ts`
Expected: PASS, `5 passing`.

- [ ] **Step 9: RFC and snapshot**

`docs/plans/authz-v3-rfc/RA14-1.md`:

```markdown
# RA14-1: `@spinajs/teams` public API

Status: proposed (L14, 2026-10-14).

## Problem

Teams and groups (design `docs/plans/2026-10-14-teams-design.md`) need a stable surface that `@spinajs/teams-http`
(L15) and apps code against while the services are built.

## Change

New snapshotted entry point `packages/teams/src/api.ts`: the constants `TEAM_TYPE`, `GROUP_TYPE`,
`TEAM_MEMBER_ROLE`, `TEAM_OWNER_ROLE`, `GROUP_MEMBER_ROLE`, `TEAM_PURGED_EVENT`; `TeamSubject`; the views and
inputs; the abstract DI tokens `TeamService`, `GroupService`, `InvitationService`, `InvitationMailer`,
`VerifiedEmailSource`; `InvitationRefused`. Implementations register themselves under these tokens.

Lists (`listTeams`, `listGroups`, `InvitationService.list`, `members`) take a `Page` and return `{ items, total }`.
`InvitationService.revoke` and `resend` take the team id and answer ResourceNotFound for another team's invitation.
`InvitationRefused.code` is stable (`INVITATION_REFUSALS`).
`transferOwnership(actor, teamId, to, { keepAs })`: the previous owner keeps `keepAs` (default `team.admin`, null: nothing).

Deviations from the design, recorded in lane L14 "Decisions": `purgeDue` takes no actor (scheduler);
`restoreTeam` is added; `resend` rotates the token; invitation escalation is judged by an AuthzAdmin dry run,
not `AuthzService.covers`; verified email comes from `VerifiedEmailSource`, which the app registers.

## Affected lanes

- L15 builds the REST API on these tokens.
```

Run (repo root):

```bash
npm run build
node scripts/api-snapshot.mjs --update
node scripts/api-snapshot.mjs --check
```

Expected: the build succeeds; `--update` prints `wrote packages/teams/etc/teams.api.md`; `--check` prints `API snapshots are up to date`.

- [ ] **Step 10: Commit**

```bash
git add packages/teams tsconfig.build.json tsconfig.build.cjs.json package.json package-lock.json scripts/api-snapshot.json docs/plans/authz-v3-rfc/RA14-1.md
git commit -m "feat(teams): package scaffold, public api and teams.* config schema"
```

---
### Task 2: Migration, `Team` and `Group`, shared helpers

**Files:**
- Create: `packages/teams/src/migrations/Teams_2026_10_14_00_00_00.ts`, `src/migrations/index.ts`, `src/models/Team.ts`, `src/models/Group.ts`, `src/models/index.ts`, `src/refs.ts`, `src/validate.ts`, `src/views.ts`, `src/host.ts`, `src/lookup.ts`
- Modify: `packages/teams/src/index.ts`
- Create (test): `packages/teams/test/support/db.ts`, `packages/teams/test/support/project.ts`
- Test: `packages/teams/test/models/models.test.ts`, `packages/teams/test/models/validate.test.ts`

**Interfaces:**
- Consumes: L3 `AccessResource`, `Parent` (from `@spinajs/authz-orm`), `AUTHZ_RESOURCE_ANCESTOR_TABLE` columns `resource_type, resource_id, ancestor_type, ancestor_id, depth`; migrations `AuthzRbac_2026_10_01_00_00_00`, `AuthzAdminIdempotency_2026_10_02_00_01_00` (authz-rbac), `AuthzAbac_2026_10_01_00_00_00` (authz-abac), `AuthzScopeAttribute_2026_10_02_00_00_00`, `AuthzAudit_2026_10_01_00_00_00`, `AuthzResourceAncestor_2026_10_14_00_00_00` (authz-orm; if `AuthzAudit_…` is not a root export use `@spinajs/authz-orm/audit`, as L9 Task 1 notes).
- Produces:
  - `Team`, `Group` models (snake_case properties = columns); migration `Teams_2026_10_14_00_00_00`.
  - `src/refs.ts`: `teamRef(id): ResourceRef`, `groupRef(id): ResourceRef`.
  - `src/validate.ts`: `readId(v, field): string`, `readSlug(v, field?)`, `readName(v, field?)`, `readDescription(v, field?): string | null`, `readRole(v, field?)`, `readEmail(v, field?)`, `readScope(v, field?): ResourceRef`, `readPage(v): Page`.
  - `src/views.ts`: `toTeamView(t)`, `toGroupView(g)`, `dateOf(v): Date | null`.
  - `src/host.ts`: `teamsDomain(): Promise<string>`, `domainService(): Promise<AuthzService>`, `domainContainer(): Promise<IContainer>`, `teamsDriver(): Promise<OrmDriver>`, `asSystem(fn)`, `asActor(actor, fn)`, `assertAllowed(actor, permission, resource)`, `execute(actor, commands, reason, opts?: { dryRun?: boolean })`.
  - `src/lookup.ts`: `anyTeam(id, field?)`, `liveTeam(id, field?)`, `liveGroup(id, field?)`, `groupParent(teamId, parentId): Promise<Group>` (the same-team rule), `teamLineage(id): Promise<string[]>`, `groupLineage(id): Promise<string[]>`.
  - Test support: `teamsDb(): Promise<TeamsDb>` (`{ orm, driver, rows(table, where?) }`), `MIGRATIONS`, `onClose(fn)`; `TestProject` (`@AccessResource('project')`, `@Parent('team') team_id`, table `test_projects`), the app type Task 5 checks team roles on.

- [ ] **Step 1: The test database**

`packages/teams/test/support/project.ts`:

```ts
import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

/** An app resource owned by a team, as an app declares one. */
@Connection('default')
@Model('test_projects')
@AccessResource('project')
export class TestProject extends ModelBase<TestProject> {
  @Primary()
  public id: string;

  @Parent('team')
  public team_id: string;

  public name: string;
}
```

`packages/teams/test/support/db.ts`:

```ts
import '@spinajs/log';
import '@spinajs/orm-sqlite';

import { AuthzAbac_2026_10_01_00_00_00 } from '@spinajs/authz-abac';
import { AuthzAudit_2026_10_01_00_00_00, AuthzResourceAncestor_2026_10_14_00_00_00, AuthzScopeAttribute_2026_10_02_00_00_00 } from '@spinajs/authz-orm';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00 } from '@spinajs/authz-rbac';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver, OrmMigration } from '@spinajs/orm';

// Imported before the Orm resolves: the decorators register the models under '__models__'.
import { Teams_2026_10_14_00_00_00 } from '../../src/index.js';
import './project.js';

export interface TeamsDb {
  readonly orm: Orm;
  readonly driver: OrmDriver;
  rows(table: string, where?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

/** Run in order on connection `default` (the authz stores, the ancestor table and the teams tables share it). */
export const MIGRATIONS: (new () => OrmMigration)[] = [
  AuthzRbac_2026_10_01_00_00_00,
  AuthzAdminIdempotency_2026_10_02_00_01_00,
  AuthzAbac_2026_10_01_00_00_00,
  AuthzScopeAttribute_2026_10_02_00_00_00,
  AuthzAudit_2026_10_01_00_00_00,
  AuthzResourceAncestor_2026_10_14_00_00_00,
  Teams_2026_10_14_00_00_00,
];

let opened: Promise<TeamsDb> | undefined;
const closers: (() => Promise<void>)[] = [];

/** Runs before the database closes, last registered first. */
export function onClose(fn: () => Promise<void>): void {
  closers.push(fn);
}

async function open(): Promise<TeamsDb> {
  const cfg = await testHost.installHost();
  cfg.set('logger', SILENT_LOGGER);
  // Migration.OnStartup stays off: the list above runs by hand, so no other imported package's migration runs.
  cfg.set('db', { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }] });
  const orm = (await DI.resolve(Orm)) as Orm;
  const driver = orm.Connections.get('default');
  if (!driver) throw new Error('teams test db: no connection default');
  for (const M of MIGRATIONS) await new M().up(driver);
  await driver.schema().createTable('test_projects', (table) => {
    table.string('id', 36).notNull().primaryKey();
    table.string('team_id', 36).notNull();
    table.string('name', 128).notNull();
  });
  // The Orm read the table info before the tables existed.
  await orm.reloadTableInfo();
  return {
    orm,
    driver,
    rows: async (table, where = {}) => (await driver.select().from(table).where(where)) as Record<string, unknown>[],
  };
}

/** One in-memory database per mocha process, shared by every test file. */
export function teamsDb(): Promise<TeamsDb> {
  return (opened ??= open());
}

// A root hook: it runs once, after every test file.
after(async function () {
  this.timeout(60000);
  if (!opened) return;
  const db = await opened;
  for (const fn of closers.splice(0).reverse()) await fn();
  DI.RootContainer.uncache(Orm);
  await db.orm.dispose();
  await testHost.uninstallHost();
  opened = undefined;
});
```

- [ ] **Step 2: Write the failing tests**

`packages/teams/test/models/validate.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { InvalidArgument } from '@spinajs/exceptions';

import { readDescription, readEmail, readName, readPage, readRole, readScope, readSlug } from '../../src/validate.js';

const expect = chai.expect;

describe('teams input validation', () => {
  it('reads slugs, names, descriptions, roles, emails, scopes and pages', () => {
    expect(readSlug('core-team')).to.equal('core-team');
    expect(readName('  Core  ')).to.equal('Core');
    expect(readDescription(undefined)).to.equal(null);
    expect(readDescription('x')).to.equal('x');
    expect(readRole('team.admin')).to.equal('team.admin');
    expect(readEmail(' Ann@Example.COM ')).to.equal('ann@example.com');
    expect(readScope({ type: 'team', id: 't1' })).to.deep.equal({ type: 'team', id: 't1' });
    expect(readScope({ type: '$global' })).to.deep.equal({ type: '$global' });
    expect(readPage(undefined)).to.deep.equal({ limit: 100, offset: 0 });
    expect(readPage({ limit: 5, offset: 10 })).to.deep.equal({ limit: 5, offset: 10 });
  });

  it('refuses bad values with InvalidArgument naming the field', () => {
    const field = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).to.be.instanceOf(InvalidArgument);
        return (e as InvalidArgument).fieldName;
      }
      throw new Error('expected InvalidArgument');
    };
    expect(field(() => readSlug('Core Team'))).to.equal('slug');
    expect(field(() => readSlug('-x'))).to.equal('slug');
    expect(field(() => readSlug('x'.repeat(65)))).to.equal('slug');
    expect(field(() => readName('   '))).to.equal('name');
    expect(field(() => readName('x'.repeat(129)))).to.equal('name');
    expect(field(() => readRole('has space'))).to.equal('role');
    expect(field(() => readEmail('not-an-email'))).to.equal('email');
    expect(field(() => readScope({ type: 'team' }))).to.equal('scope');
    expect(field(() => readPage({ limit: 0, offset: 0 }))).to.equal('page');
  });
});
```

`packages/teams/test/models/models.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { Group, Team } from '../../src/index.js';
import { asSystem } from '../../src/host.js';
import { groupParent, liveGroup, liveTeam, teamLineage } from '../../src/lookup.js';
import { toGroupView, toTeamView } from '../../src/views.js';
import { teamsDb } from '../support/db.js';
import type { TeamsDb } from '../support/db.js';

const expect = chai.expect;

async function team(parentId: string | null = null, extra: Partial<Team> = {}): Promise<Team> {
  const now = DateTime.now();
  const t = new Team({ id: randomUUID(), parent_id: parentId, slug: `t-${randomUUID().slice(0, 8)}`, name: 'T', description: null, archived_at: null, deleted_at: null, created_by: 'user:test', created_at: now, updated_at: now, ...extra });
  await asSystem(() => t.insert());
  return t;
}

async function group(teamId: string, parentId: string | null = null): Promise<Group> {
  const now = DateTime.now();
  const g = new Group({ id: randomUUID(), team_id: teamId, parent_id: parentId, slug: `g-${randomUUID().slice(0, 8)}`, name: 'G', description: null, created_by: 'user:test', created_at: now, updated_at: now });
  await asSystem(() => g.insert());
  return g;
}

describe('Team and Group models', function () {
  let db: TeamsDb;

  before(async () => {
    db = await teamsDb();
  });

  it('keeps the scope tree: sub-team → team, group → team, nested group → group', async () => {
    const root = await team();
    const sub = await team(root.id);
    const outer = await group(sub.id);
    const inner = await group(sub.id, outer.id);
    const above = async (type: string, id: string) => (await db.rows('authz_resource_ancestor', { resource_type: type, resource_id: id })).map((r) => `${String(r.ancestor_type)}:${String(r.ancestor_id)}`);
    expect(await above('team', sub.id)).to.include(`team:${root.id}`);
    expect(await above('group', outer.id)).to.include.members([`team:${sub.id}`, `team:${root.id}`]);
    expect(await above('group', inner.id)).to.include.members([`group:${outer.id}`, `team:${sub.id}`, `team:${root.id}`]);
  });

  it('round-trips rows into frozen views with Dates', async () => {
    const t = await team();
    const view = toTeamView(await liveTeam(t.id));
    expect(view).to.include({ id: t.id, parentId: null, slug: t.slug, name: 'T', description: null, archivedAt: null, deletedAt: null, createdBy: 'user:test' });
    expect(view.createdAt).to.be.instanceOf(Date);
    expect(Object.isFrozen(view)).to.equal(true);
    const g = await group(t.id);
    expect(toGroupView(await liveGroup(g.id))).to.include({ id: g.id, teamId: t.id, parentId: null });
  });

  it('liveTeam and liveGroup hide deleted teams and their groups', async () => {
    const t = await team(null, { deleted_at: DateTime.now() });
    const g = await group(t.id);
    for (const p of [liveTeam(t.id), liveGroup(g.id), liveTeam(randomUUID())]) {
      expect(await p.catch((e: unknown) => e)).to.be.instanceOf(ResourceNotFound);
    }
  });

  it('a group parent must be a live group of the same team', async () => {
    const a = await team();
    const b = await team();
    const ga = await group(a.id);
    const gb = await group(b.id);
    expect((await groupParent(a.id, ga.id)).id).to.equal(ga.id);
    const e = await groupParent(a.id, gb.id).catch((err: unknown) => err);
    expect(e).to.be.instanceOf(InvalidArgument);
    expect((e as InvalidArgument).fieldName).to.equal('parentId');
  });

  it('teamLineage lists a team and its ancestors, nearest first', async () => {
    const root = await team();
    const mid = await team(root.id);
    const leaf = await team(mid.id);
    expect(await teamLineage(leaf.id)).to.deep.equal([leaf.id, mid.id, root.id]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/models/validate.test.ts test/models/models.test.ts`
Expected: FAIL, `Cannot find module '../../src/validate.js'`.

- [ ] **Step 4: The migration**

`src/migrations/Teams_2026_10_14_00_00_00.ts`:

```ts
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** Teams design §6. No ON DELETE CASCADE: rows go through model deletes, so authz-orm forgets their scopes. */
@Migration('default')
export class Teams_2026_10_14_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('teams', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('parent_id', 36);
      table.string('slug', 64).notNull().unique();
      table.string('name', 128).notNull();
      table.text('description');
      table.dateTime('archived_at');
      table.dateTime('deleted_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.foreignKey('parent_id').references('teams', 'id');
    });

    await connection.schema().createTable('groups', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('team_id', 36).notNull();
      table.string('parent_id', 36);
      table.string('slug', 64).notNull();
      table.string('name', 128).notNull();
      table.text('description');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.foreignKey('team_id').references('teams', 'id');
      table.foreignKey('parent_id').references('groups', 'id');
    });

    await connection.index().unique().table('groups').name('groups_team_slug').columns(['team_id', 'slug']);
    await connection.index().table('teams').name('teams_parent').columns(['parent_id']);
    await connection.index().table('groups').name('groups_parent').columns(['parent_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('groups');
    await connection.schema().dropTable('teams');
  }
}
```

`src/migrations/index.ts`:

```ts
export * from './Teams_2026_10_14_00_00_00.js';
```

- [ ] **Step 5: The models**

`src/models/Team.ts`:

```ts
import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, CreatedAt, DateTime as DT, Model, ModelBase, Primary, UpdatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('teams')
@AccessResource('team')
export class Team extends ModelBase<Team> {
  @Primary()
  public id: string;

  @Parent('team', { nullable: true })
  public parent_id: string | null;

  public slug: string;

  public name: string;

  public description: string | null;

  @DT()
  public archived_at: DateTime | null;

  // Kept by the service, not @SoftDelete: purge must still select deleted rows.
  @DT()
  public deleted_at: DateTime | null;

  public created_by: string | null;

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;
}
```

`src/models/Group.ts`:

```ts
import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, CreatedAt, Model, ModelBase, Primary, UpdatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('groups')
@AccessResource('group')
export class Group extends ModelBase<Group> {
  @Primary()
  public id: string;

  @Parent('team')
  public team_id: string;

  @Parent('group', { nullable: true })
  public parent_id: string | null;

  public slug: string;

  public name: string;

  public description: string | null;

  public created_by: string | null;

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;
}
```

`src/models/index.ts`:

```ts
export * from './Team.js';
export * from './Group.js';
```

- [ ] **Step 6: Helpers**

`src/refs.ts`:

```ts
import type { ResourceRef } from '@spinajs/authz';

import { GROUP_TYPE, TEAM_TYPE } from './api.js';

export const teamRef = (id: string): ResourceRef => Object.freeze({ type: TEAM_TYPE, id });
export const groupRef = (id: string): ResourceRef => Object.freeze({ type: GROUP_TYPE, id });
```

`src/validate.ts`:

```ts
import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import type { Page } from './api.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ROLE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PAGE = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (field: string, message: string) => new InvalidArgument(`${field}: ${message}`, field);

export function readId(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '' || v.length > 64) throw bad(field, 'must be an id of 1 to 64 characters');
  return v;
}

export function readSlug(v: unknown, field = 'slug'): string {
  if (typeof v !== 'string' || !SLUG.test(v)) throw bad(field, 'must be 1 to 64 lowercase letters, digits or inner dashes');
  return v;
}

export function readName(v: unknown, field = 'name'): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (name === '' || name.length > 128) throw bad(field, 'must be 1 to 128 characters');
  return name;
}

export function readDescription(v: unknown, field = 'description'): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > 10000) throw bad(field, 'must be a string of at most 10000 characters');
  return v;
}

export function readRole(v: unknown, field = 'role'): string {
  if (typeof v !== 'string' || !ROLE.test(v)) throw bad(field, 'must be a role name');
  return v;
}

export function readEmail(v: unknown, field = 'email'): string {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (email.length > 255 || !EMAIL.test(email)) throw bad(field, 'must be an email address');
  return email;
}

export function readScope(v: unknown, field = 'scope'): ResourceRef {
  if (!isRecord(v) || typeof v.type !== 'string' || v.type === '') throw bad(field, 'must be { type, id }');
  if (v.type === GLOBAL.type) return GLOBAL;
  if (typeof v.id !== 'string' || v.id === '') throw bad(field, 'must name a resource id');
  return Object.freeze({ type: v.type, id: v.id });
}

export function readPage(v: unknown): Page {
  if (v === undefined) return { limit: 100, offset: 0 };
  const p = isRecord(v) ? v : {};
  const limit = p.limit ?? 100;
  const offset = p.offset ?? 0;
  if (!Number.isInteger(limit) || (limit as number) < 1 || !Number.isInteger(offset) || (offset as number) < 0) throw bad('page', 'must be { limit >= 1, offset >= 0 }');
  return { limit: Math.min(limit as number, MAX_PAGE), offset: offset as number };
}
```

`src/views.ts`:

```ts
import { DateTime } from 'luxon';

import type { GroupView, TeamView } from './api.js';
import type { Group } from './models/Group.js';
import type { Team } from './models/Team.js';

export function dateOf(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof DateTime) return v.toJSDate();
  if (v instanceof Date) return v;
  return new Date(String(v));
}

export function toTeamView(t: Team): TeamView {
  return Object.freeze({
    id: t.id,
    parentId: t.parent_id ?? null,
    slug: t.slug,
    name: t.name,
    description: t.description ?? null,
    archivedAt: dateOf(t.archived_at),
    deletedAt: dateOf(t.deleted_at),
    createdBy: t.created_by ?? null,
    createdAt: dateOf(t.created_at)!,
    updatedAt: dateOf(t.updated_at)!,
  });
}

export function toGroupView(g: Group): GroupView {
  return Object.freeze({
    id: g.id,
    teamId: g.team_id,
    parentId: g.parent_id ?? null,
    slug: g.slug,
    name: g.name,
    description: g.description ?? null,
    createdBy: g.created_by ?? null,
    createdAt: dateOf(g.created_at)!,
    updatedAt: dateOf(g.updated_at)!,
  });
}
```

`src/host.ts`:

```ts
import { AuthzAdminFailure, AuthzDomains, AuthzService, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { AuthzCommand, AuthzCommandResult, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** The domain authz-orm keeps the teams' ancestors in. */
export async function teamsDomain(): Promise<string> {
  const cfg = (await DI.resolve(Configuration)) as Configuration;
  const name = cfg.get<unknown>(['authz', 'orm', 'domain'], 'root');
  return typeof name === 'string' && name !== '' ? name : 'root';
}

export async function domainService(): Promise<AuthzService> {
  const domain = await teamsDomain();
  if (domain === 'root') return (await DI.resolve(AuthzService)) as AuthzService;
  return (await DI.resolve(AuthzDomains)).service(domain);
}

export async function domainContainer(): Promise<IContainer> {
  const domain = await teamsDomain();
  if (domain === 'root') return DI.RootContainer;
  return (await DI.resolve(AuthzDomains)).container(domain);
}

export async function teamsDriver(): Promise<OrmDriver> {
  const driver = ((await DI.resolve(Orm)) as Orm).Connections.get('default');
  if (!driver) throw new InvalidOperation('@spinajs/teams: no ORM connection named default');
  return driver;
}

export const asSystem = <T>(fn: () => Promise<T>): Promise<T> => runWithPrincipal(SYSTEM, fn);

export const asActor = <T>(actor: Principal, fn: () => Promise<T>): Promise<T> => runWithPrincipal(actor, fn);

/** @throws AccessDenied */
export async function assertAllowed(actor: Principal, permission: Permission, resource: ResourceRef): Promise<void> {
  await (await domainService()).assert(actor, permission, resource);
}

/** One AuthzAdmin batch; the first failed command is thrown as AuthzAdminFailure. */
export async function execute(actor: Principal, commands: readonly AuthzCommand[], reason: string, opts: { readonly dryRun?: boolean } = {}): Promise<readonly AuthzCommandResult[]> {
  if (commands.length === 0) return [];
  const results = await (await domainService()).admin().execute(actor, commands, { reason, ...(opts.dryRun ? { dryRun: true } : {}) });
  for (const r of results) if (!r.ok) throw new AuthzAdminFailure(r.error.code, r.error.message, r.error.field);
  return results;
}
```

`src/lookup.ts`:

```ts
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';

import { asSystem } from './host.js';
import { Group } from './models/Group.js';
import { Team } from './models/Team.js';
import { readId } from './validate.js';

/** A team row, deleted or not. */
export async function anyTeam(id: unknown, field = 'teamId'): Promise<Team> {
  const key = readId(id, field);
  const team = await asSystem(() => Team.where('id', key).first());
  if (!team) throw new ResourceNotFound(`team ${key} does not exist`);
  return team;
}

export async function liveTeam(id: unknown, field = 'teamId'): Promise<Team> {
  const team = await anyTeam(id, field);
  if (team.deleted_at) throw new ResourceNotFound(`team ${team.id} does not exist`);
  return team;
}

/** A group of a live team. */
export async function liveGroup(id: unknown, field = 'groupId'): Promise<Group> {
  const key = readId(id, field);
  const group = await asSystem(() => Group.where('id', key).first());
  if (!group) throw new ResourceNotFound(`group ${key} does not exist`);
  await liveTeam(group.team_id).catch(() => {
    throw new ResourceNotFound(`group ${key} does not exist`);
  });
  return group;
}

/** Teams design §6: a group's parent group must belong to the same team. */
export async function groupParent(teamId: string, parentId: unknown): Promise<Group> {
  const parent = await liveGroup(parentId, 'parentId').catch(() => {
    throw new InvalidArgument('parentId: no such group', 'parentId');
  });
  if (parent.team_id !== teamId) throw new InvalidArgument('parentId: the parent group belongs to another team', 'parentId');
  return parent;
}

async function lineage(id: string, load: (id: string) => Promise<{ parent_id: string | null } | undefined>): Promise<string[]> {
  const out: string[] = [];
  let next: string | null = id;
  while (next !== null && !out.includes(next)) {
    out.push(next);
    next = (await load(next))?.parent_id ?? null;
  }
  return out;
}

/** The team and its ancestors, nearest first. */
export function teamLineage(id: string): Promise<string[]> {
  return lineage(id, (k) => asSystem(() => Team.where('id', k).first()));
}

/** The group and its ancestor groups, nearest first. */
export function groupLineage(id: string): Promise<string[]> {
  return lineage(id, (k) => asSystem(() => Group.where('id', k).first()));
}
```

`src/index.ts` becomes:

```ts
export * from './api.js';
export * from './schema.js';
export * from './models/index.js';
export * from './migrations/index.js';
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/models/validate.test.ts test/models/models.test.ts`
Expected: PASS, `7 passing`. (These cases boot no AuthzService: the ancestor rows come from L3's `AncestorMiddleware`, which needs only the table.)

- [ ] **Step 8: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): teams and groups tables, models and lookups"
```

---

### Task 3: Config fragment (roles, permissions, archived policy, admin mapping) and the booted test stack

**Files:**
- Create: `packages/teams/src/config/teams.ts`
- Create (test): `packages/teams/test/support/stack.ts`, `packages/teams/test/support/people.ts`
- Test: `packages/teams/test/config/boot.test.ts`

**Interfaces:**
- Consumes: Task 2 `teamsDb`, `onClose`, `execute`; `registerRbac(container, configuration)`, `RoleStore` (authz-rbac); `AbacModel`, `AbacContributor`, `ConfigPolicyStore` (authz-abac); `DbScopeAttributeStore` (authz-orm); `userPrincipal` (authz-testing); L8's `authz.admin.guard.keepHolders: { role, scopeType }[]` (code `last_holder`); boot rule 12 (overview decision 23).
- Produces:
  - `src/config/teams.ts` default export (the fragment; teams §4, §5 and lane decision 2).
  - Test support: `teamsStack(): Promise<TeamsStack>` (`TeamsDb & { authz, admin, events: RecordingEventSink, config }`), `deepMerge`, `TEST_CONFIG`, `INVITATION_SECRET`; `person(name, attributes?)`, `refOf(p)`, `teamCreator(name?)`, `failure(promise)`.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/config/boot.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { GLOBAL } from '@spinajs/authz';
import { RoleStore } from '@spinajs/authz-rbac';
import { DI } from '@spinajs/di';

import teamsConfig from '../../src/config/teams.js';
import { person, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;

describe('teams config fragment', function () {
  let stack: TeamsStack;

  before(async () => {
    stack = await teamsStack();
  });

  it('registers every teams permission with the types it is checked on; reads are list permissions', () => {
    const p = teamsConfig.authz.permissions;
    expect(Object.keys(p).sort()).to.deep.equal(
      ['group:create', 'group:delete', 'group:members.manage', 'group:read', 'group:update', 'team:archive', 'team:create', 'team:delete', 'team:invitations.manage', 'team:members.manage', 'team:ownership.transfer', 'team:read', 'team:roles.manage', 'team:update'].sort(),
    );
    expect(p['team:read']).to.include({ list: true });
    expect(p['group:read']).to.include({ list: true });
    expect(p['group:create'].types).to.deep.equal(['group', 'team']);
    // Every permission checked at a ref of another type declares that type (the engine refuses it otherwise).
    expect(p['team:roles.manage'].types).to.include('group');
    expect(p['team:create'].types).to.deep.equal(['team']);
    expect(p['team:roles.manage'].types).to.deep.equal(['team', 'group']);
  });

  it('ships the roles of teams §4, one owner per team, and the archived deny policy', () => {
    const { rbac, abac, admin } = teamsConfig.authz;
    expect(rbac.ladders.team).to.deep.equal({ roles: ['team.member', 'team.admin', 'team.owner'] });
    expect(Object.keys(rbac.roles)).to.deep.equal(['team.member', 'team.admin', 'team.owner', 'group.member', 'group.manager']);
    expect(rbac.roles['team.member']).to.include({ subjectSet: true, ladder: 'team' });
    expect(rbac.roles['group.member']).to.include({ subjectSet: true });
    expect(admin.guard.keepHolders).to.deep.equal([{ role: 'team.owner', scopeType: 'team' }]);
    expect(abac.policies.map((p) => [p.id, p.permissions, p.resourceTypes])).to.deep.equal([
      ['teams.archived.write', ['*:create', '*:update'], ['team', 'group']],
      ['teams.archived.delete', ['*:delete'], ['group']],
    ]);
    for (const p of abac.policies) expect(p).to.deep.include({ effect: 'deny', when: { attr: 'scope.team.archived', eq: true } });
  });

  it('boots a domain with the fragment: boot rule 12 accepts team:read and group:read', async () => {
    const stranger = person('stranger');
    for (const permission of ['team:read', 'group:read']) {
      const plan = await stack.authz.accessPlan(stranger, permission, permission.split(':')[0]);
      expect(['none', 'filter']).to.include(plan.kind);
    }
    const roles = await ((await DI.RootContainer.resolve(RoleStore)) as RoleStore).load();
    expect(roles.roles.map((r) => r.name)).to.include.members(['team.member', 'team.admin', 'team.owner', 'group.member', 'group.manager']);
  });

  it('team:create at $global comes from an app role (the test stack ships teams.creator)', async () => {
    const creator = await teamCreator();
    expect(await stack.authz.can(creator, 'team:create', GLOBAL)).to.equal(true);
    expect(await stack.authz.can(person('stranger'), 'team:create', GLOBAL)).to.equal(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/config/boot.test.ts`
Expected: FAIL, `Cannot find module '../../src/config/teams.js'`.

- [ ] **Step 3: The fragment**

`src/config/teams.ts`:

```ts
const team = (description: string, extra: Record<string, unknown> = {}) => ({ types: ['team'], description, ...extra });
const group = (description: string, extra: Record<string, unknown> = {}) => ({ types: ['group'], description, ...extra });

/**
 * Teams design §4-5. Apps extend, replace or drop any part through their own config; arrays (policies,
 * keepHolders) are concatenated by the configuration merge.
 */
const teamsConfig = {
  authz: {
    permissions: {
      'team:read': team('Read a team', { list: true }),
      'team:update': team('Rename or move a team'),
      'team:members.manage': team('Add and remove team members'),
      'team:roles.manage': { types: ['team', 'group'], description: 'Change the roles held at a team or its groups' },
      'team:invitations.manage': team('Invite to a team'),
      'team:delete': team('Delete a team'),
      'team:archive': team('Archive and unarchive a team'),
      'team:ownership.transfer': team('Hand the team to another owner'),
      'team:create': team('Create a sub-team here (at $global: a root team)'),
      'group:read': group('Read a group', { list: true }),
      // Checked at the team the group goes into, so it declares team as well as group.
      'group:create': { types: ['group', 'team'], description: 'Create a group in a team' },
      'group:update': group('Rename or move a group'),
      'group:delete': group('Delete a group'),
      'group:members.manage': group('Add and remove group members'),
    },
    rbac: {
      // No resourceTypes: the ladder's grants apply to every type below a team, app types included.
      ladders: { team: { roles: ['team.member', 'team.admin', 'team.owner'] } },
      roles: {
        'team.member': { subjectSet: true, scopeTypes: ['team'], ladder: 'team', grants: ['team:read', 'group:read'] },
        'team.admin': {
          scopeTypes: ['team'],
          ladder: 'team',
          extends: ['team.member'],
          grants: ['team:update', 'team:members.manage', 'team:roles.manage', 'team:invitations.manage', 'group:create', 'group:update', 'group:delete', 'group:members.manage'],
        },
        'team.owner': { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'], grants: ['team:delete', 'team:archive', 'team:ownership.transfer', 'team:create'] },
        'group.member': { subjectSet: true, scopeTypes: ['group'], grants: ['group:read'] },
        'group.manager': { scopeTypes: ['group'], extends: ['group.member'], grants: ['group:update', 'group:members.manage'] },
      },
    },
    abac: {
      // scope.team.* on a resource without a team ancestor is indeterminate, so both policies name their types;
      // apps add their own team-owned types with the same condition.
      policies: [
        {
          id: 'teams.archived.write',
          effect: 'deny',
          // team:archive matches neither, so an archived team can still be unarchived.
          permissions: ['*:create', '*:update'],
          resourceTypes: ['team', 'group'],
          when: { attr: 'scope.team.archived', eq: true },
          reason: 'team_archived',
        },
        {
          id: 'teams.archived.delete',
          effect: 'deny',
          // Not on team: archiving must never block deleting the team.
          permissions: ['*:delete'],
          resourceTypes: ['group'],
          when: { attr: 'scope.team.archived', eq: true },
          reason: 'team_archived',
        },
      ],
    },
    scopes: {
      attributes: {
        team: { schema: { type: 'object', properties: { archived: { type: 'boolean' } } }, defaults: { archived: false } },
      },
    },
    admin: {
      // AuthzAdmin checks these at team and group scopes instead of authz:*; SYSTEM batches are checked too.
      permissions: {
        'assignment.*': { team: 'team:members.manage', group: 'team:roles.manage' },
        'set.*': { team: 'team:members.manage', group: 'group:members.manage' },
        'scope.setAttributes': { team: 'team:archive' },
        'list.assignments': { team: 'team:read', group: 'group:read' },
      },
      guard: { keepHolders: [{ role: 'team.owner', scopeType: 'team' }] },
    },
  },
};

export default teamsConfig;
```

- [ ] **Step 4: The test stack**

`packages/teams/test/support/stack.ts`:

```ts
import { AuthorizationModel, AuthzContributor, AuthzEventSink, AuthzService, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzAdmin, AuthzEvent } from '@spinajs/authz';
import { AbacContributor, AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { registerRbac } from '@spinajs/authz-rbac';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import teamsConfig from '../../src/config/teams.js';
import { teamsDb } from './db.js';
import type { TeamsDb } from './db.js';

export const INVITATION_SECRET = 'teams-test-invitation-secret-of-at-least-32-chars';

type TestConfiguration = ReturnType<typeof testHost.config>;

export class RecordingEventSink extends AuthzEventSink {
  readonly events: AuthzEvent[] = [];

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The configuration merge: objects deep, arrays concatenated. */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const cur = out[k];
    if (Array.isArray(cur) && Array.isArray(v)) out[k] = [...cur, ...v];
    else if (isRecord(cur) && isRecord(v)) out[k] = deepMerge(cur, v);
    else out[k] = structuredClone(v);
  }
  return out;
}

/** What an app adds to the fragment: stores, the guard, a role that may create root teams, rights on an app type, the invitation secret. */
export const TEST_CONFIG = {
  // The env key authz-orm's runtime guard reads (L9 Task 0 records it): 'test' makes an unscoped multi-row select throw.
  env: 'test',
  teams: { membership: { subTeamsInParent: true }, deletion: { graceDays: 30 }, invitations: { secret: INVITATION_SECRET, defaultTtlHours: 168, subject: 'You are invited to join a team' } },
  authz: {
    permissions: { 'authz:assignments.manage': {}, 'project:read': { types: ['project'] }, 'project:update': { types: ['project'] } },
    rbac: {
      connection: 'default',
      stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
      // grants concatenate with the fragment's: an app giving team roles rights on its own type below the team.
      roles: { 'teams.creator': { grants: ['team:create'], scopeTypes: ['$global'] }, 'team.member': { grants: ['project:read'] }, 'team.admin': { grants: ['project:update'] } },
    },
    admin: {
      connection: 'default',
      backend: 'DbAuthzAdminBackend',
      guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
    },
  },
};

export interface TeamsStack extends TeamsDb {
  readonly authz: AuthzService;
  readonly admin: AuthzAdmin;
  readonly events: RecordingEventSink;
  readonly config: TestConfiguration;
}

let booted: Promise<TeamsStack> | undefined;

async function boot(): Promise<TeamsStack> {
  const db = await teamsDb();
  const config = testHost.config();
  const merged = deepMerge(deepMerge({}, teamsConfig as unknown as Record<string, unknown>), TEST_CONFIG);
  for (const [k, v] of Object.entries(merged)) config.set(k, v);

  const root = DI.RootContainer;
  const events = new RecordingEventSink();
  root.register(testHost.instance(events)).as(AuthzEventSink);
  const attributes = new DbScopeAttributeStore({ container: root });
  root.register(testHost.instance(attributes)).as(ScopeAttributeStore);
  root.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
  const abac = new AbacModel({ stores: [new ConfigPolicyStore(config.get<unknown[]>(['authz', 'abac', 'policies'], []))] });
  root.register(testHost.instance(abac)).as(AuthorizationModel);
  root.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
  await registerRbac(root, config);

  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  return { ...db, authz, admin: authz.admin(), events, config };
}

/** The booted root domain over the shared test database; once per mocha process. */
export function teamsStack(): Promise<TeamsStack> {
  return (booted ??= boot());
}
```

`packages/teams/test/support/people.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';

import { execute } from '../../src/host.js';

/** A user nobody else in the run shares. */
export function person(name: string, attributes: Record<string, unknown> = {}): Principal {
  return userPrincipal(`${name}-${randomUUID().slice(0, 8)}`, { attributes });
}

export const refOf = (p: Principal): PrincipalRef => ({ type: p.type, id: p.id });

/** A user holding the test role `teams.creator` at $global. */
export async function teamCreator(name = 'creator', attributes: Record<string, unknown> = {}): Promise<Principal> {
  const p = person(name, attributes);
  await execute(SYSTEM, [{ kind: 'assignment.grant', subject: refOf(p), role: 'teams.creator', scope: GLOBAL }], 'test: team creator');
  return p;
}

/** The rejection of `p`; fails when it resolves. */
export async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}
```

- [ ] **Step 5: Run the test**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/config/boot.test.ts`
Expected: PASS, `4 passing`. A boot failure naming `[6.5/12]` means a model cannot plan `team:read`/`group:read`: report it to the owning lane (L8 for RBAC, L10 for ABAC) with the message; do not drop `list: true`. A failure naming `keepHolders` means L8's guard config does not know the key yet (contract issue 8).

- [ ] **Step 6: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): roles, permissions, archived policy and admin mapping fragment; booted test stack"
```

---

### Task 4: Subject mapping and `teamsOf`

**Files:**
- Create: `packages/teams/src/subjects.ts`, `packages/teams/src/membership.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/subjects/subjects.test.ts`, `packages/teams/test/subjects/teams-of.test.ts`

**Interfaces:**
- Consumes: `subjectKeyOf(subject): string` (L6) and `parseSetKey(key): SetSubject | undefined` (L8 Task 4), both from `@spinajs/authz-rbac`; `MembershipStore.setsOf(memberKeys, at)` (L0/L6), `AssignmentStore.forSubjects(subjects, at)` (authz-rbac contract), Task 2 helpers, Task 3 stack.
- Produces:
  - `src/subjects.ts`: `teamSet(teamId): AssignmentSubject`, `groupSet(groupId): AssignmentSubject`, `readSubject(v, field?): TeamSubject`, `toAssignmentSubject(s: TeamSubject): AssignmentSubject`, `fromAssignmentSubject(s: AssignmentSubject): TeamSubject | undefined`, `subjectLabel(s: TeamSubject): string`, `parseSubjectLabel(label: string): TeamSubject` (L15 path segments `user:<id>`, `group:<id>`, `team:<id>`), `assertSubjectExists(s): Promise<void>`.
  - `src/membership.ts`: `principalTeams(principal: PrincipalRef, now?: Date): Promise<PrincipalTeams>` (Task 5 exposes it as `TeamService.teamsOf`).

- [ ] **Step 1: Write the failing tests**

`packages/teams/test/subjects/subjects.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { InvalidArgument } from '@spinajs/exceptions';

import { fromAssignmentSubject, groupSet, parseSubjectLabel, readSubject, subjectLabel, teamSet, toAssignmentSubject } from '../../src/subjects.js';

const expect = chai.expect;

describe('team subjects', () => {
  it('maps users, groups and teams to assignment subjects and back', () => {
    expect(toAssignmentSubject({ type: 'user', id: 'u1' })).to.deep.equal({ type: 'user', id: 'u1' });
    expect(toAssignmentSubject({ group: 'g1' })).to.deep.equal({ set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } });
    expect(toAssignmentSubject({ team: 't1' })).to.deep.equal({ set: { role: 'team.member', scope: { type: 'team', id: 't1' } } });
    expect(fromAssignmentSubject(groupSet('g1'))).to.deep.equal({ group: 'g1' });
    expect(fromAssignmentSubject(teamSet('t1'))).to.deep.equal({ team: 't1' });
    expect(fromAssignmentSubject({ type: 'user', id: 'u1' })).to.deep.equal({ type: 'user', id: 'u1' });
    expect(fromAssignmentSubject({ set: { role: 'org.member', scope: { type: 'org', id: 'o' } } })).to.equal(undefined);
  });

  it('reads exactly one subject shape', () => {
    expect(readSubject({ group: 'g' })).to.deep.equal({ group: 'g' });
    expect(readSubject({ team: 't' })).to.deep.equal({ team: 't' });
    expect(readSubject({ type: 'user', id: 'u' })).to.deep.equal({ type: 'user', id: 'u' });
    for (const bad of [null, {}, { group: '' }, { group: 'g', team: 't' }, { type: 'user' }, { type: 'user', id: 'u', group: 'g' }]) {
      expect(() => readSubject(bad)).to.throw(InvalidArgument);
    }
  });

  it('labels subjects for URLs', () => {
    expect(subjectLabel({ type: 'user', id: '42' })).to.equal('user:42');
    expect(subjectLabel({ group: 'g' })).to.equal('group:g');
    expect(parseSubjectLabel('user:42')).to.deep.equal({ type: 'user', id: '42' });
    expect(parseSubjectLabel('group:g')).to.deep.equal({ group: 'g' });
    expect(parseSubjectLabel('team:t')).to.deep.equal({ team: 't' });
    expect(() => parseSubjectLabel('nocolon')).to.throw(InvalidArgument);
  });
});
```

`packages/teams/test/subjects/teams-of.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { SYSTEM } from '@spinajs/authz';
import { DateTime } from 'luxon';

import { Group, Team } from '../../src/index.js';
import { asSystem, execute } from '../../src/host.js';
import { principalTeams } from '../../src/membership.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { groupSet, teamSet } from '../../src/subjects.js';
import { person, refOf } from '../support/people.js';
import { teamsStack } from '../support/stack.js';

const expect = chai.expect;

async function team(name: string, parentId: string | null = null): Promise<Team> {
  const now = DateTime.now();
  const t = new Team({ id: randomUUID(), parent_id: parentId, slug: `t-${randomUUID().slice(0, 8)}`, name, description: null, archived_at: null, deleted_at: null, created_by: null, created_at: now, updated_at: now });
  await asSystem(() => t.insert());
  return t;
}

async function group(name: string, teamId: string, parentId: string | null = null): Promise<Group> {
  const now = DateTime.now();
  const g = new Group({ id: randomUUID(), team_id: teamId, parent_id: parentId, slug: `g-${randomUUID().slice(0, 8)}`, name, description: null, created_by: null, created_at: now, updated_at: now });
  await asSystem(() => g.insert());
  return g;
}

describe('teamsOf', function () {
  before(async () => {
    await teamsStack();
  });

  it('lists the teams and groups a principal belongs to, through nested sets, with the roles held at each', async () => {
    const top = await team('Top');
    const sub = await team('Sub', top.id);
    const outer = await group('Outer', sub.id);
    const inner = await group('Inner', sub.id, outer.id);
    const u = person('u');
    const a = person('a');
    const v = person('v');
    await execute(
      SYSTEM,
      [
        { kind: 'assignment.grant', subject: teamSet(sub.id), role: 'team.member', scope: teamRef(top.id) },
        { kind: 'assignment.grant', subject: groupSet(outer.id), role: 'team.member', scope: teamRef(sub.id) },
        { kind: 'assignment.grant', subject: groupSet(inner.id), role: 'group.member', scope: groupRef(outer.id) },
        { kind: 'set.addMember', set: { role: 'group.member', scope: groupRef(inner.id) }, member: refOf(u) },
        { kind: 'assignment.grant', subject: refOf(a), role: 'team.admin', scope: teamRef(sub.id) },
      ],
      'test: teamsOf world',
    );

    const of = await principalTeams(refOf(u));
    expect(of.teams.map((t) => [t.name, t.roles])).to.deep.equal([
      ['Sub', ['team.member']],
      ['Top', ['team.member']],
    ]);
    expect(of.groups.map((g) => [g.name, g.roles])).to.deep.equal([
      ['Inner', ['group.member']],
      ['Outer', ['group.member']],
    ]);
    expect(Object.isFrozen(of)).to.equal(true);

    const admin = await principalTeams(refOf(a));
    expect(admin.teams.map((t) => [t.name, t.roles])).to.deep.equal([
      ['Sub', ['team.admin']],
      ['Top', ['team.member']],
    ]);
    expect(admin.groups).to.deep.equal([]);

    expect(await principalTeams(refOf(v))).to.deep.equal({ teams: [], groups: [] });

    await asSystem(() => top.update({ deleted_at: DateTime.now() }));
    expect((await principalTeams(refOf(u))).teams.map((t) => t.name)).to.deep.equal(['Sub']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/subjects/subjects.test.ts test/subjects/teams-of.test.ts`
Expected: FAIL, `Cannot find module '../../src/subjects.js'`.

- [ ] **Step 3: `src/subjects.ts`**

```ts
import type { AssignmentSubject } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { GROUP_MEMBER_ROLE, GROUP_TYPE, TEAM_MEMBER_ROLE, TEAM_TYPE } from './api.js';
import type { TeamSubject } from './api.js';
import { liveGroup, liveTeam } from './lookup.js';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

export const groupSet = (groupId: string): AssignmentSubject => ({ set: { role: GROUP_MEMBER_ROLE, scope: { type: GROUP_TYPE, id: groupId } } });
export const teamSet = (teamId: string): AssignmentSubject => ({ set: { role: TEAM_MEMBER_ROLE, scope: { type: TEAM_TYPE, id: teamId } } });

export function readSubject(v: unknown, field = 'subject'): TeamSubject {
  const bad = () => new InvalidArgument(`${field} must be { type, id }, { group } or { team }`, field);
  if (!isRecord(v)) throw bad();
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'group' && nonEmpty(v.group)) return { group: v.group };
  if (keys === 'team' && nonEmpty(v.team)) return { team: v.team };
  if (keys === 'id,type' && nonEmpty(v.type) && nonEmpty(v.id)) return { type: v.type, id: v.id };
  throw bad();
}

export function toAssignmentSubject(s: TeamSubject): AssignmentSubject {
  if ('group' in s) return groupSet(s.group);
  if ('team' in s) return teamSet(s.team);
  return { type: s.type, id: s.id };
}

/** The TeamSubject of an assignment subject; undefined for sets teams do not model. */
export function fromAssignmentSubject(s: AssignmentSubject): TeamSubject | undefined {
  if (!('set' in s)) return { type: s.type, id: s.id };
  const { role, scope } = s.set;
  if (!nonEmpty(scope.id)) return undefined;
  if (role === GROUP_MEMBER_ROLE && scope.type === GROUP_TYPE) return { group: scope.id };
  if (role === TEAM_MEMBER_ROLE && scope.type === TEAM_TYPE) return { team: scope.id };
  return undefined;
}

export function subjectLabel(s: TeamSubject): string {
  if ('group' in s) return `${GROUP_TYPE}:${s.group}`;
  if ('team' in s) return `${TEAM_TYPE}:${s.team}`;
  return `${s.type}:${s.id}`;
}

/** `group:<id>` and `team:<id>` name member sets; any other `type:id` is a principal. */
export function parseSubjectLabel(label: string): TeamSubject {
  const at = typeof label === 'string' ? label.indexOf(':') : -1;
  if (at <= 0 || at === label.length - 1) throw new InvalidArgument('subject must be <type>:<id>', 'subject');
  const type = label.slice(0, at);
  const id = label.slice(at + 1);
  if (type === GROUP_TYPE) return { group: id };
  if (type === TEAM_TYPE) return { team: id };
  return { type, id };
}

/** Groups and teams named as subjects must be live; principals are not looked up. */
export async function assertSubjectExists(s: TeamSubject): Promise<void> {
  if ('group' in s) await liveGroup(s.group, 'subject.group');
  else if ('team' in s) await liveTeam(s.team, 'subject.team');
}
```

- [ ] **Step 4: `src/membership.ts`**

```ts
import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';
import { AssignmentStore, MembershipStore, parseSetKey, subjectKeyOf } from '@spinajs/authz-rbac';
import { InvalidOperation } from '@spinajs/exceptions';

import { GROUP_MEMBER_ROLE, GROUP_TYPE, TEAM_MEMBER_ROLE, TEAM_TYPE } from './api.js';
import type { GroupView, PrincipalTeams, TeamView } from './api.js';
import { asSystem, domainContainer } from './host.js';
import { Group } from './models/Group.js';
import { Team } from './models/Team.js';
import { toGroupView, toTeamView } from './views.js';

type SetSubject = NonNullable<ReturnType<typeof parseSetKey>>;

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Teams design §7 `teamsOf`: the sets the principal belongs to (closure, so nested groups and sub-teams count) and the
 * roles it or those sets hold at team and group scopes. One closure read and one assignment read.
 */
export async function principalTeams(principal: PrincipalRef, now: Date = new Date()): Promise<PrincipalTeams> {
  const container = await domainContainer();
  if (!container.hasRegistered(MembershipStore) || !container.hasRegistered(AssignmentStore)) {
    throw new InvalidOperation('@spinajs/teams: teamsOf needs the RBAC AssignmentStore and MembershipStore of the teams domain (authz.rbac.stores)');
  }
  const memberships = (await container.resolve(MembershipStore)) as MembershipStore;
  const assignments = (await container.resolve(AssignmentStore)) as AssignmentStore;
  const me: PrincipalRef = { type: principal.type, id: principal.id };

  const sets = (await memberships.setsOf([subjectKeyOf(me)], now)).map((m) => parseSetKey(m.setKey)).filter((s): s is SetSubject => s !== undefined);
  const roles = new Map<string, Set<string>>();
  const hold = (type: string, id: string, role?: string) => {
    const key = `${type}:${id}`;
    const held = roles.get(key) ?? new Set<string>();
    if (role !== undefined) held.add(role);
    roles.set(key, held);
  };
  for (const { set } of sets) {
    const id = set.scope.id;
    if (typeof id !== 'string') continue;
    if ((set.role === TEAM_MEMBER_ROLE && set.scope.type === TEAM_TYPE) || (set.role === GROUP_MEMBER_ROLE && set.scope.type === GROUP_TYPE)) hold(set.scope.type, id);
  }
  const subjects: AssignmentSubject[] = [me, ...sets];
  for (const a of await assignments.forSubjects(subjects, now)) {
    if ((a.scope.type === TEAM_TYPE || a.scope.type === GROUP_TYPE) && typeof a.scope.id === 'string') hold(a.scope.type, a.scope.id, a.role);
  }

  const idsOf = (type: string) => [...roles.keys()].filter((k) => k.startsWith(`${type}:`)).map((k) => k.slice(type.length + 1));
  const groupIds = idsOf(GROUP_TYPE);
  const groups = groupIds.length > 0 ? ((await asSystem(() => Group.query().whereIn('id', groupIds))) as Group[]) : [];
  const teamIds = [...new Set([...idsOf(TEAM_TYPE), ...groups.map((g) => g.team_id)])];
  const teams = teamIds.length > 0 ? ((await asSystem(() => Team.query().whereIn('id', teamIds).whereNull('deleted_at'))) as Team[]) : [];
  const live = new Set(teams.map((t) => t.id));
  const rolesAt = (type: string, id: string) => Object.freeze([...(roles.get(`${type}:${id}`) ?? [])].sort());

  return Object.freeze({
    teams: Object.freeze(
      teams
        .filter((t) => roles.has(`${TEAM_TYPE}:${t.id}`))
        .map((t): TeamView & { roles: readonly string[] } => Object.freeze({ ...toTeamView(t), roles: rolesAt(TEAM_TYPE, t.id) }))
        .sort(byName),
    ),
    groups: Object.freeze(
      groups
        .filter((g) => live.has(g.team_id))
        .map((g): GroupView & { roles: readonly string[] } => Object.freeze({ ...toGroupView(g), roles: rolesAt(GROUP_TYPE, g.id) }))
        .sort(byName),
    ),
  });
}
```

`src/index.ts` gains:

```ts
export { fromAssignmentSubject, parseSubjectLabel, readSubject, subjectLabel, toAssignmentSubject } from './subjects.js';
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/subjects/subjects.test.ts test/subjects/teams-of.test.ts`
Expected: PASS, `4 passing`. A missing `Top` for `u` means the closure did not follow set → set → set: that is L6 (set-in-set closure), report it with the case.

- [ ] **Step 6: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): subject mapping and teamsOf over the membership closure"
```

---

### Task 5: `TeamService`: create, read, list, update, move, archive

**Files:**
- Create: `packages/teams/src/services/common.ts`, `packages/teams/src/services/links.ts`, `packages/teams/src/services/team-service.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/teams/team-service.test.ts`

**Interfaces:**
- Consumes: Task 2 (`liveTeam`, `teamLineage`, `execute`, `assertAllowed`, `asSystem`, `asActor`, views, validation), Task 4 (`teamSet`, `groupSet`, `principalTeams`), L4 `.accessible(permission)` on model selects.
- Produces:
  - `DefaultTeamService` (`@Singleton() @Injectable(TeamService)`) with `createTeam`, `getTeam`, `listTeams`, `updateTeam`, `moveTeam`, `archiveTeam`, `unarchiveTeam`, `teamsOf`; the methods of Tasks 6 and 8 throw `MethodNotImplemented` until those tasks replace them.
  - `src/services/common.ts`: `reasonOf(op, actor): string`, `undoOnFailure(work, undo)`, `ownerOf(actor, owner?): PrincipalRef`, `isSystem(p): boolean`, `createdBy(actor): string`, `pageOf(actor, page, query, view): Promise<Paged<V>>` (count + one page by name, as the actor; a `none` plan makes `.accessible()` throw `AccessDenied`, lists answer `{ items: [], total: 0 }`).
  - `src/services/links.ts`: `link(subject, role, scope)`, `unlink(subject, scope)`, `linkSubTeam(teamId, parentId)`, `unlinkSubTeam(teamId, parentId)`, `groupLinkTarget(g)`, `linkGroup(g)`, `unlinkGroup(g)`, `archivedAttribute(teamId, archived)`.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/teams/team-service.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AccessDenied, SYSTEM } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { randomUUID } from 'node:crypto';

import { TeamService } from '../../src/index.js';
import { asSystem, execute } from '../../src/host.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { TestProject } from '../support/project.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('TeamService: create, update, move, archive', function () {
  let stack: TeamsStack;
  let teams: TeamService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
  });

  const addMember = (teamId: string, who: { type: string; id: string }) => execute(SYSTEM, [{ kind: 'assignment.grant', subject: who, role: 'team.member', scope: teamRef(teamId) }], 'test');

  it('a creator creates a root team and owns it; a stranger may not', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('core'), name: 'Core', description: 'd' });
    expect(t).to.include({ parentId: null, name: 'Core', description: 'd', archivedAt: null, deletedAt: null });
    expect(await stack.authz.can(creator, 'team:delete', teamRef(t.id))).to.equal(true);
    expect(await failure(teams.createTeam(person('stranger'), { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('writes authz first: a failed insert leaves no owner assignment behind', async () => {
    const creator = await teamCreator();
    const s = slug('race');
    await teams.createTeam(creator, { slug: s, name: 'First' });
    // Same slug past the service's check: the unique index refuses the insert after the batch ran.
    const service = teams as unknown as { assertSlugFree(slug: string): Promise<void> };
    const check = service.assertSlugFree;
    service.assertSlugFree = async () => undefined;
    try {
      expect(await failure(teams.createTeam(creator, { slug: s, name: 'Second' }))).to.be.instanceOf(Error);
    } finally {
      service.assertSlugFree = check;
    }
    const owners = await stack.rows('authz_assignment', { subject_type: 'user', subject_id: creator.id, role: 'team.owner' });
    expect(owners).to.have.length(1);
  });

  it('team roles reach app resources below the team (the ladder has no resourceTypes)', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('app'), name: 'App' });
    const project = new TestProject({ id: randomUUID(), team_id: t.id, name: 'P' });
    await asSystem(() => project.insert());
    const m = person('m');
    await addMember(t.id, refOf(m));
    const ref = { type: 'project', id: project.id };
    expect(await stack.authz.can(m, 'project:read', ref)).to.equal(true);
    expect(await stack.authz.can(m, 'project:update', ref)).to.equal(false);
    expect(await stack.authz.can(creator, 'project:update', ref)).to.equal(true);
    expect(await stack.authz.can(person('stranger'), 'project:read', ref)).to.equal(false);
  });

  it('refuses a taken slug and a bad one; a SYSTEM caller must name the owner', async () => {
    const creator = await teamCreator();
    const s = slug('dup');
    await teams.createTeam(creator, { slug: s, name: 'A' });
    expect(await failure(teams.createTeam(creator, { slug: s, name: 'B' }))).to.be.instanceOf(ResourceDuplicated);
    expect(await failure(teams.createTeam(creator, { slug: 'Bad Slug', name: 'B' }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(teams.createTeam(SYSTEM, { slug: slug('sys'), name: 'S' }))).to.be.instanceOf(InvalidArgument);
    const owner = person('owner');
    const t = await teams.createTeam(SYSTEM, { slug: slug('sys'), name: 'S', owner: refOf(owner) });
    expect(await stack.authz.can(owner, 'team:delete', teamRef(t.id))).to.equal(true);
  });

  it('an owner creates sub-teams; sub-team members are members of the parent unless switched off', async () => {
    const creator = await teamCreator();
    const parent = await teams.createTeam(creator, { slug: slug('p'), name: 'P' });
    const sub = await teams.createTeam(creator, { slug: slug('s'), name: 'S', parentId: parent.id });
    const m = person('m');
    await addMember(sub.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(parent.id))).to.equal(true);

    stack.config.set(['teams', 'membership', 'subTeamsInParent'], false);
    try {
      const lone = await teams.createTeam(creator, { slug: slug('l'), name: 'L', parentId: parent.id });
      const n = person('n');
      await addMember(lone.id, refOf(n));
      expect(await stack.authz.can(n, 'team:read', teamRef(parent.id))).to.equal(false);
    } finally {
      stack.config.set(['teams', 'membership', 'subTeamsInParent'], true);
    }
    expect(await failure(teams.createTeam(person('stranger'), { slug: slug('x'), name: 'X', parentId: parent.id }))).to.be.instanceOf(AccessDenied);
  });

  it('updates a team; only with team:update', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('u'), name: 'U' });
    const s = slug('renamed');
    expect(await teams.updateTeam(creator, t.id, { name: 'Renamed', slug: s, description: null })).to.include({ name: 'Renamed', slug: s, description: null });
    expect(await failure(teams.updateTeam(person('stranger'), t.id, { name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('moves a team: the sub-team set is re-linked; a team cannot move below itself', async () => {
    const creator = await teamCreator();
    const a = await teams.createTeam(creator, { slug: slug('a'), name: 'A' });
    const b = await teams.createTeam(creator, { slug: slug('b'), name: 'B' });
    const s = await teams.createTeam(creator, { slug: slug('s'), name: 'S', parentId: a.id });
    const m = person('m');
    await addMember(s.id, refOf(m));
    expect((await teams.moveTeam(creator, s.id, b.id)).parentId).to.equal(b.id);
    expect(await stack.authz.can(m, 'team:read', teamRef(b.id))).to.equal(true);
    expect(await stack.authz.can(m, 'team:read', teamRef(a.id))).to.equal(false);
    expect(await failure(teams.moveTeam(creator, b.id, s.id))).to.be.instanceOf(InvalidArgument);
    expect((await teams.moveTeam(creator, s.id, null)).parentId).to.equal(null);
    expect(await stack.authz.can(m, 'team:read', teamRef(b.id))).to.equal(false);
  });

  it('archive freezes writes on the team (deny policy), keeps reads and deleting the team; unarchive thaws', async () => {
    const creator = await teamCreator();
    const t = await teams.createTeam(creator, { slug: slug('arch'), name: 'Arch' });
    expect((await teams.archiveTeam(creator, t.id)).archivedAt).to.be.instanceOf(Date);
    expect(await stack.authz.can(creator, 'team:delete', teamRef(t.id))).to.equal(true);
    const denied = await failure(teams.updateTeam(creator, t.id, { name: 'X' }));
    expect(denied).to.be.instanceOf(AccessDenied);
    expect((denied as AccessDenied).decision.reason?.code).to.equal('team_archived');
    expect(await stack.authz.can(creator, 'team:read', teamRef(t.id))).to.equal(true);
    expect(await failure(teams.createTeam(creator, { slug: slug('sub'), name: 'Sub', parentId: t.id }))).to.be.instanceOf(AccessDenied);
    expect((await teams.unarchiveTeam(creator, t.id)).archivedAt).to.equal(null);
    expect((await teams.updateTeam(creator, t.id, { name: 'Thawed' })).name).to.equal('Thawed');
  });

  it('lists the live teams the actor may read', async () => {
    const creator = await teamCreator();
    const p = await teams.createTeam(creator, { slug: slug('lp'), name: 'LP' });
    const c = await teams.createTeam(creator, { slug: slug('lc'), name: 'LC', parentId: p.id });
    const mine = await teams.listTeams(creator);
    expect(mine.items.map((t) => t.id)).to.include.members([p.id, c.id]);
    expect(mine.total).to.equal(mine.items.length);
    expect(await teams.listTeams(creator, { parentId: p.id })).to.deep.include({ total: 1 });
    expect((await teams.listTeams(creator, { parentId: p.id })).items.map((t) => t.id)).to.deep.equal([c.id]);
    const first = await teams.listTeams(creator, { page: { limit: 1, offset: 0 } });
    expect(first.items).to.have.length(1);
    expect(first.total).to.equal(mine.total);
    expect((await teams.listTeams(person('stranger'))).items.map((t) => t.id)).to.not.include(p.id);
    expect((await teams.teamsOf(refOf(creator))).teams.map((t) => t.id)).to.include.members([p.id, c.id]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/team-service.test.ts`
Expected: FAIL, `TeamService` resolves to nothing: `DI.resolve(TeamService)` throws (no implementation registered for an abstract class).

- [ ] **Step 3: `src/services/common.ts` and `src/services/links.ts`**

`src/services/common.ts`:

```ts
import { AccessDenied, SYSTEM, principalKey } from '@spinajs/authz';
import type { Principal, PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import type { ISelectQueryBuilder } from '@spinajs/orm';

import type { Page, Paged } from '../api.js';
import { asActor } from '../host.js';
import { readSubject } from '../subjects.js';

export const isSystem = (p: Principal): boolean => p === SYSTEM || (p.type === SYSTEM.type && p.id === SYSTEM.id);

/** The audit reason of a teams batch; the actor is named because structural batches run as SYSTEM. */
export const reasonOf = (op: string, actor: Principal): string => `teams:${op} by ${principalKey(actor)}`;

/** The key stored in `created_by` columns (varchar 100). */
export const createdBy = (actor: Principal): string => principalKey(actor).slice(0, 100);

export function ownerOf(actor: Principal, owner: unknown): PrincipalRef {
  if (owner !== undefined) {
    const s = readSubject(owner, 'owner');
    if ('group' in s || 'team' in s) throw new InvalidArgument('owner must be a principal { type, id }', 'owner');
    return s;
  }
  if (isSystem(actor)) throw new InvalidArgument('owner: a SYSTEM caller must name the owner', 'owner');
  return { type: actor.type, id: actor.id };
}

/**
 * One page and the total of a list query. `query` builds a fresh builder each time (marks such as `.accessible()` are
 * per builder). `.accessible()` throws AccessDenied when the plan is `none`: a list the actor may see nothing of is empty.
 */
export async function pageOf<M, V>(actor: Principal, page: Page, query: () => ISelectQueryBuilder<M[]>, view: (m: M) => V): Promise<Paged<V>> {
  try {
    return await asActor(actor, async () => {
      const total = await query().selectCount();
      const rows = (await query().orderBy('name').skip(page.offset).take(page.limit)) as M[];
      return Object.freeze({ items: Object.freeze(rows.map(view)), total: Number(total) });
    });
  } catch (e) {
    if (e instanceof AccessDenied) return Object.freeze({ items: Object.freeze([]), total: 0 });
    throw e;
  }
}

/**
 * Runs `work`; when it fails, runs `undo` and rethrows the failure of `work`. DbAuthzAdminBackend refuses to join a
 * caller transaction, so a model write and its authz batch cannot commit together (lane decision 12).
 */
export async function undoOnFailure<T>(work: () => Promise<T>, undo: () => Promise<unknown>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    // The batch error is the one to report.
    await undo().catch(() => undefined);
    throw e;
  }
}
```

`src/services/links.ts`:

```ts
import type { AssignmentSubject, AuthzCommand, ResourceRef } from '@spinajs/authz';

import { GROUP_MEMBER_ROLE, TEAM_MEMBER_ROLE } from '../api.js';
import { groupRef, teamRef } from '../refs.js';
import { groupSet, teamSet } from '../subjects.js';

export const link = (subject: AssignmentSubject, role: string, scope: ResourceRef): AuthzCommand => ({ kind: 'assignment.grant', subject, role, scope });

/** Every role `subject` holds at `scope`: a moved set keeps nothing at its old place. */
export const unlink = (subject: AssignmentSubject, scope: ResourceRef): AuthzCommand => ({ kind: 'assignment.revokeWhere', scope, subject });

export const linkSubTeam = (teamId: string, parentId: string): AuthzCommand => link(teamSet(teamId), TEAM_MEMBER_ROLE, teamRef(parentId));
export const unlinkSubTeam = (teamId: string, parentId: string): AuthzCommand => unlink(teamSet(teamId), teamRef(parentId));

/** Teams design §3: a nested group joins its outer group's set, a top-level group its team's set. */
export function groupLinkTarget(g: { readonly team_id: string; readonly parent_id: string | null }): { role: string; scope: ResourceRef } {
  return g.parent_id ? { role: GROUP_MEMBER_ROLE, scope: groupRef(g.parent_id) } : { role: TEAM_MEMBER_ROLE, scope: teamRef(g.team_id) };
}

export const linkGroup = (g: { readonly id: string; readonly team_id: string; readonly parent_id: string | null }): AuthzCommand => {
  const target = groupLinkTarget(g);
  return link(groupSet(g.id), target.role, target.scope);
};

export const unlinkGroup = (g: { readonly id: string; readonly team_id: string; readonly parent_id: string | null }): AuthzCommand => unlink(groupSet(g.id), groupLinkTarget(g).scope);

export const archivedAttribute = (teamId: string, archived: boolean): AuthzCommand => ({ kind: 'scope.setAttributes', scope: teamRef(teamId), patch: { archived } });
```

- [ ] **Step 4: `src/services/team-service.ts`**

```ts
import { randomUUID } from 'node:crypto';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { TEAM_OWNER_ROLE, TeamService } from '../api.js';
import type { CreateTeamInput, MemberEntry, Page, Paged, PrincipalTeams, TeamSubject, TeamView, UpdateTeamInput } from '../api.js';
import { asSystem, assertAllowed, execute } from '../host.js';
import { liveTeam, teamLineage } from '../lookup.js';
import { principalTeams } from '../membership.js';
import { Team } from '../models/Team.js';
import { teamRef } from '../refs.js';
import { readDescription, readId, readName, readPage, readSlug } from '../validate.js';
import { toTeamView } from '../views.js';
import { createdBy, ownerOf, pageOf, reasonOf, undoOnFailure } from './common.js';
import { archivedAttribute, linkSubTeam, unlinkSubTeam } from './links.js';

@Singleton()
@Injectable(TeamService)
export class DefaultTeamService extends TeamService {
  @Config('teams.membership.subTeamsInParent', { defaultValue: true })
  protected SubTeamsInParent: boolean;

  @Config('teams.deletion.graceDays', { defaultValue: 30 })
  protected GraceDays: number;

  async createTeam(actor: Principal, input: CreateTeamInput): Promise<TeamView> {
    const slug = readSlug(input?.slug);
    const name = readName(input?.name);
    const description = readDescription(input?.description);
    const owner = ownerOf(actor, input?.owner);
    const parent = input?.parentId == null ? null : await liveTeam(input.parentId, 'parentId');
    await assertAllowed(actor, 'team:create', parent ? teamRef(parent.id) : GLOBAL);
    await this.assertSlugFree(slug);

    const now = DateTime.now();
    const team = new Team({ id: randomUUID(), parent_id: parent?.id ?? null, slug, name, description, archived_at: null, deleted_at: null, created_by: createdBy(actor), created_at: now, updated_at: now });
    const scope = teamRef(team.id);
    const linkTo = parent && this.SubTeamsInParent ? parent.id : null;
    // Authz first (lane decision 12): a crash after it leaves inert assignments, never a team without an owner.
    // SYSTEM: the actor holds nothing on the new team yet; it passed team:create above.
    const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject: owner, role: TEAM_OWNER_ROLE, scope }, archivedAttribute(team.id, false)];
    if (linkTo) commands.push(linkSubTeam(team.id, linkTo));
    await execute(SYSTEM, commands, reasonOf('create', actor));
    await undoOnFailure(
      () => asSystem(() => team.insert()),
      () =>
        execute(
          SYSTEM,
          [{ kind: 'assignment.revokeWhere', scope, subject: owner, role: TEAM_OWNER_ROLE }, { kind: 'scope.setAttributes', scope, patch: { archived: null } }, ...(linkTo ? [unlinkSubTeam(team.id, linkTo)] : [])],
          reasonOf('create-undo', actor),
        ),
    );
    return toTeamView(team);
  }

  async getTeam(actor: Principal, id: string): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:read', teamRef(team.id));
    return toTeamView(team);
  }

  async listTeams(actor: Principal, opts: { readonly parentId?: string | null; readonly page?: Page } = {}): Promise<Paged<TeamView>> {
    const parentId = opts.parentId === undefined || opts.parentId === null ? opts.parentId : readId(opts.parentId, 'parentId');
    const query = () => {
      let q = Team.query().accessible('team:read').whereNull('deleted_at');
      if (parentId === null) q = q.whereNull('parent_id');
      else if (parentId !== undefined) q = q.where('parent_id', parentId);
      return q;
    };
    return pageOf(actor, readPage(opts.page), query, (t: Team) => toTeamView(t));
  }

  async updateTeam(actor: Principal, id: string, input: UpdateTeamInput): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:update', teamRef(team.id));
    const changes: Partial<Team> = {};
    if (input?.slug !== undefined) {
      const slug = readSlug(input.slug);
      if (slug !== team.slug) {
        await this.assertSlugFree(slug);
        changes.slug = slug;
      }
    }
    if (input?.name !== undefined) changes.name = readName(input.name);
    if (input?.description !== undefined) changes.description = readDescription(input.description);
    if (Object.keys(changes).length > 0) await asSystem(() => team.update({ ...changes, updated_at: DateTime.now() }));
    return toTeamView(await liveTeam(team.id));
  }

  async moveTeam(actor: Principal, id: string, parentId: string | null): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    const parent = parentId === null ? null : await liveTeam(parentId, 'parentId');
    await assertAllowed(actor, 'team:update', teamRef(team.id));
    await assertAllowed(actor, 'team:create', parent ? teamRef(parent.id) : GLOBAL);
    const from = team.parent_id ?? null;
    const to = parent?.id ?? null;
    if (from === to) return toTeamView(team);
    if (to !== null && (await teamLineage(to)).includes(team.id)) throw new InvalidArgument('parentId: a team cannot move below itself', 'parentId');

    // A @Parent update: authz-orm rewrites the closure of the team and everything below it.
    await asSystem(() => team.update({ parent_id: to, updated_at: DateTime.now() }));
    const commands: AuthzCommand[] = [...(from ? [unlinkSubTeam(team.id, from)] : []), ...(to && this.SubTeamsInParent ? [linkSubTeam(team.id, to)] : [])];
    await undoOnFailure(
      () => execute(SYSTEM, commands, reasonOf('move', actor)),
      () => asSystem(() => team.update({ parent_id: from })),
    );
    return toTeamView(await liveTeam(team.id));
  }

  async archiveTeam(actor: Principal, id: string): Promise<TeamView> {
    return this.setArchived(actor, id, true);
  }

  async unarchiveTeam(actor: Principal, id: string): Promise<TeamView> {
    return this.setArchived(actor, id, false);
  }

  async teamsOf(principal: PrincipalRef): Promise<PrincipalTeams> {
    return principalTeams({ type: principal.type, id: principal.id });
  }

  // ---- Task 6 ----

  async members(_actor: Principal, _teamId: string, _page?: Page): Promise<Paged<MemberEntry>> {
    throw new MethodNotImplemented('DefaultTeamService.members: lane L14 Task 6');
  }

  async addTeamMember(_actor: Principal, _teamId: string, _subject: TeamSubject, _role?: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.addTeamMember: lane L14 Task 6');
  }

  async removeTeamMember(_actor: Principal, _teamId: string, _subject: TeamSubject): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.removeTeamMember: lane L14 Task 6');
  }

  async setTeamRole(_actor: Principal, _teamId: string, _subject: TeamSubject, _role: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.setTeamRole: lane L14 Task 6');
  }

  async transferOwnership(_actor: Principal, _teamId: string, _to: PrincipalRef, _opts?: { readonly keepAs?: string | null }): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.transferOwnership: lane L14 Task 6');
  }

  async grant(_actor: Principal, _subject: TeamSubject, _role: string, _scope: ResourceRef): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.grant: lane L14 Task 6');
  }

  async revoke(_actor: Principal, _subject: TeamSubject, _role: string, _scope: ResourceRef): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.revoke: lane L14 Task 6');
  }

  // ---- Task 8 ----

  async deleteTeam(_actor: Principal, _id: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.deleteTeam: lane L14 Task 8');
  }

  async restoreTeam(_actor: Principal, _id: string): Promise<TeamView> {
    throw new MethodNotImplemented('DefaultTeamService.restoreTeam: lane L14 Task 8');
  }

  async purgeTeam(_actor: Principal, _id: string): Promise<readonly string[]> {
    throw new MethodNotImplemented('DefaultTeamService.purgeTeam: lane L14 Task 8');
  }

  async purgeDue(_now?: Date): Promise<readonly string[]> {
    throw new MethodNotImplemented('DefaultTeamService.purgeDue: lane L14 Task 8');
  }

  // ---- helpers ----

  protected async assertSlugFree(slug: string): Promise<void> {
    // Deleted teams keep their slug until they are purged.
    if (await asSystem(() => Team.where('slug', slug).first())) throw new ResourceDuplicated(`team slug ${slug} is taken`);
  }

  protected async setArchived(actor: Principal, id: string, archived: boolean): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:archive', teamRef(team.id));
    if ((team.archived_at !== null && team.archived_at !== undefined) === archived) return toTeamView(team);
    const before = team.archived_at ?? null;
    await asSystem(() => team.update({ archived_at: archived ? DateTime.now() : null, updated_at: DateTime.now() }));
    await undoOnFailure(
      () => execute(SYSTEM, [archivedAttribute(team.id, archived)], reasonOf(archived ? 'archive' : 'unarchive', actor)),
      () => asSystem(() => team.update({ archived_at: before })),
    );
    return toTeamView(await liveTeam(team.id));
  }
}
```

`src/index.ts` gains:

```ts
export * from './services/team-service.js';
```

- [ ] **Step 5: Run the test**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/team-service.test.ts`
Expected: PASS, `9 passing`. If the app-type case denies `project:read`, the ladder still has `resourceTypes` somewhere in the merged config. If the archive case reads `team:read` as denied, the deny policy matched a read: check `permissions` globs in the fragment. If `listTeams` throws the runtime guard error, a multi-row select ran outside `.accessible()` or `asSystem`: fix the call, not the env.

- [ ] **Step 6: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): TeamService create, list, update, move, archive"
```

---

### Task 6: Members and roles: add, remove, set role, transfer ownership, general grant and revoke

**Files:**
- Create: `packages/teams/src/services/members.ts`
- Modify: `packages/teams/src/services/team-service.ts` (replace the seven Task 6 stubs, add two helpers)
- Test: `packages/teams/test/teams/members.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5; `AuthzAdmin.list(actor, { kind: 'assignments', scope, page })` (mapped to `team:read`/`group:read` by the fragment); L8's `keepHolders` (`last_holder`) and `DefaultAdminGuard` escalation (`escalation`).
- Produces:
  - `TeamService.members`, `addTeamMember`, `removeTeamMember`, `setTeamRole`, `transferOwnership`, `grant`, `revoke` (signatures in `api.ts`).
  - `src/services/members.ts`: `listMembers(actor, scope: ResourceRef, page?): Promise<Paged<MemberEntry>>`, `holdsAt(subject: PrincipalRef, role, scope): Promise<boolean>`, `structuralLink(teamId: string, s: TeamSubject): Promise<string | undefined>` (why removing that subject from the team would cut the team structure).
- Behaviour: a team's top-level groups and (with `subTeamsInParent`) its sub-teams are members through the structure; `removeTeamMember` refuses them (`InvalidArgument`, field `subject`). `setTeamRole` replaces every role the subject holds at the team. `grant`/`revoke` at a `team` or `group` scope need `team:roles.manage` there; at any other scope AuthzAdmin's own permission for that scope type decides (default `authz:assignments.manage`).

- [ ] **Step 1: Write the failing test**

`packages/teams/test/teams/members.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied, AuthzAdminFailure, GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const code = (e: Error) => (e instanceof AuthzAdminFailure ? e.code : e.name);

describe('TeamService: members and roles', function () {
  let stack: TeamsStack;
  let teams: TeamService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('adds and lists members; only with team:members.manage / team:read', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(team.id))).to.equal(true);
    const list = await teams.members(owner, team.id);
    expect(list.items.map((e) => [e.subject, e.role])).to.deep.include.members([
      [refOf(owner), 'team.owner'],
      [refOf(m), 'team.member'],
    ]);
    expect(await failure(teams.members(person('stranger'), team.id))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.addTeamMember(m, team.id, refOf(person('x'))))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.addTeamMember(owner, team.id, { team: team.id }))).to.be.instanceOf(InvalidArgument);
  });

  it('removes a member', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.removeTeamMember(owner, team.id, refOf(m));
    expect(await stack.authz.can(m, 'team:read', teamRef(team.id))).to.equal(false);
  });

  it('setTeamRole replaces the subject’s roles; the guard refuses escalation', async () => {
    const { owner, team } = await ownedTeam();
    const m = person('m');
    await teams.addTeamMember(owner, team.id, refOf(m));
    await teams.setTeamRole(owner, team.id, refOf(m), 'team.admin');
    expect(await stack.authz.can(m, 'team:update', teamRef(team.id))).to.equal(true);
    expect((await teams.members(owner, team.id)).items.filter((e) => 'id' in e.subject && e.subject.id === m.id).map((e) => e.role)).to.deep.equal(['team.admin']);

    const x = person('x');
    await teams.addTeamMember(m, team.id, refOf(x));
    expect(code(await failure(teams.setTeamRole(m, team.id, refOf(x), 'team.owner')))).to.equal('escalation');
    expect(code(await failure(teams.removeTeamMember(m, team.id, refOf(owner))))).to.equal('escalation');
  });

  it('keeps one owner per team (keepHolders)', async () => {
    const { owner, team } = await ownedTeam();
    expect(code(await failure(teams.setTeamRole(owner, team.id, refOf(owner), 'team.member')))).to.equal('last_holder');
    expect(code(await failure(teams.removeTeamMember(owner, team.id, refOf(owner))))).to.equal('last_holder');
    expect(await stack.authz.can(owner, 'team:delete', teamRef(team.id))).to.equal(true);
  });

  it('transfers ownership: the previous owner stays as team.admin by default', async () => {
    const { owner, team } = await ownedTeam();
    const n = person('n');
    await teams.transferOwnership(owner, team.id, refOf(n));
    expect(await stack.authz.can(n, 'team:delete', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(owner, 'team:delete', teamRef(team.id))).to.equal(false);
    expect(await stack.authz.can(owner, 'team:update', teamRef(team.id))).to.equal(true);
    expect(await failure(teams.transferOwnership(owner, team.id, refOf(owner)))).to.be.instanceOf(AccessDenied);
    expect(await failure(teams.transferOwnership(n, team.id, { group: 'g' } as never))).to.be.instanceOf(InvalidArgument);
    // Round trip: the first owner already holds team.admin, so the second transfer adds no second row.
    await teams.transferOwnership(n, team.id, refOf(owner));
    await teams.transferOwnership(owner, team.id, refOf(n));
    expect(await stack.rows('authz_assignment', { subject_type: 'user', subject_id: owner.id, scope_type: 'team', scope_id: team.id, role: 'team.admin' })).to.have.length(1);
  });

  it('transfers ownership keeping a custom role, or nothing', async () => {
    const a = await ownedTeam();
    await teams.transferOwnership(a.owner, a.team.id, refOf(person('n')), { keepAs: 'team.member' });
    expect(await stack.authz.can(a.owner, 'team:read', teamRef(a.team.id))).to.equal(true);
    expect(await stack.authz.can(a.owner, 'team:update', teamRef(a.team.id))).to.equal(false);

    const b = await ownedTeam();
    expect(await failure(teams.transferOwnership(b.owner, b.team.id, refOf(person('x')), { keepAs: 'bad role' }))).to.be.instanceOf(InvalidArgument);
    await teams.transferOwnership(b.owner, b.team.id, refOf(person('n')), { keepAs: null });
    expect(await stack.authz.can(b.owner, 'team:read', teamRef(b.team.id))).to.equal(false);
  });

  it('a whole team holds roles on another team (cross-team), granted and revoked', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const ma = person('ma');
    await teams.addTeamMember(a.owner, a.team.id, refOf(ma));
    await teams.addTeamMember(b.owner, b.team.id, { team: a.team.id });
    expect(await stack.authz.can(ma, 'team:read', teamRef(b.team.id))).to.equal(true);
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(false);

    await teams.grant(b.owner, { team: a.team.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(true);
    await teams.revoke(b.owner, { team: a.team.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(ma, 'team:update', teamRef(b.team.id))).to.equal(false);

    expect(await failure(teams.grant(ma, { team: a.team.id }, 'team.admin', teamRef(b.team.id)))).to.be.instanceOf(AccessDenied);
    expect(code(await failure(teams.grant(b.owner, refOf(ma), 'teams.creator', GLOBAL)))).to.equal('forbidden');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/members.test.ts`
Expected: FAIL, `MethodNotImplemented: DefaultTeamService.addTeamMember: lane L14 Task 6`.

- [ ] **Step 3: `src/services/members.ts`**

```ts
import type { Assignment, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';

import type { MemberEntry, Paged, Page, TeamSubject } from '../api.js';
import { asSystem, domainContainer, domainService } from '../host.js';
import { Group } from '../models/Group.js';
import { Team } from '../models/Team.js';
import { fromAssignmentSubject } from '../subjects.js';
import { readPage } from '../validate.js';

/** The assignments at `scope`, read as the actor (AuthzAdmin checks the `list.assignments` permission mapped for the scope type). */
export async function listMembers(actor: Principal, scope: ResourceRef, page?: Page): Promise<Paged<MemberEntry>> {
  const out = await (await domainService()).admin().list(actor, { kind: 'assignments', scope, page: readPage(page) });
  const items: MemberEntry[] = [];
  for (const a of out.items as Assignment[]) {
    const subject = fromAssignmentSubject(a.subject);
    if (subject) items.push(Object.freeze({ subject, role: a.role, assignmentId: a.id, expiresAt: a.expiresAt ?? null }));
  }
  return Object.freeze({ items: Object.freeze(items), total: out.total });
}

/** Whether `subject` holds `role` directly at `scope` (a live row of its own, not through a set). */
export async function holdsAt(subject: PrincipalRef, role: string, scope: ResourceRef): Promise<boolean> {
  const container = await domainContainer();
  if (!container.hasRegistered(AssignmentStore)) return false;
  const rows = await ((await container.resolve(AssignmentStore)) as AssignmentStore).forSubjects([subject], new Date());
  return rows.some((a) => a.role === role && a.scope.type === scope.type && a.scope.id === scope.id);
}

/** Why `s` is a member of the team through the team structure (teams design §3), or undefined. */
export async function structuralLink(teamId: string, s: TeamSubject, subTeamsInParent: boolean): Promise<string | undefined> {
  if ('group' in s) {
    const group = await asSystem(() => Group.where('id', s.group).first());
    if (group && group.team_id === teamId && !group.parent_id) return 'a top-level group of the team is a member through the team structure; move or delete the group instead';
  }
  if ('team' in s && subTeamsInParent) {
    const team = await asSystem(() => Team.where('id', s.team).first());
    if (team && team.parent_id === teamId) return 'a sub-team is a member of its parent through the team structure; move the sub-team instead';
  }
  return undefined;
}
```

- [ ] **Step 4: Replace the Task 6 stubs in `src/services/team-service.ts`**

Imports: add to the `@spinajs/authz` value import `GLOBAL, SYSTEM` (already there); add these imports:

```ts
import { GROUP_TYPE, TEAM_ADMIN_ROLE, TEAM_MEMBER_ROLE, TEAM_TYPE } from '../api.js';
import { liveGroup } from '../lookup.js';
import { assertSubjectExists, readSubject, toAssignmentSubject } from '../subjects.js';
import { readRole, readScope } from '../validate.js';
import { isSystem } from './common.js';
import { unlink } from './links.js';
import { holdsAt, listMembers, structuralLink } from './members.js';
```

(merge them into the existing import lines of the same modules; drop `MethodNotImplemented` from the exceptions import only after Task 8.)

Replace the seven methods under `// ---- Task 6 ----` with:

```ts
  // ---- Task 6 ----

  async members(actor: Principal, teamId: string, page?: Page): Promise<Paged<MemberEntry>> {
    const team = await liveTeam(teamId);
    await assertAllowed(actor, 'team:read', teamRef(team.id));
    return listMembers(actor, teamRef(team.id), page);
  }

  async addTeamMember(actor: Principal, teamId: string, subject: TeamSubject, role: string = TEAM_MEMBER_ROLE): Promise<void> {
    const team = await liveTeam(teamId);
    const s = await this.memberSubject(team.id, subject);
    const r = readRole(role);
    await assertAllowed(actor, 'team:members.manage', teamRef(team.id));
    await execute(actor, [{ kind: 'assignment.grant', subject: toAssignmentSubject(s), role: r, scope: teamRef(team.id) }], reasonOf('add-member', actor));
  }

  async removeTeamMember(actor: Principal, teamId: string, subject: TeamSubject): Promise<void> {
    const team = await liveTeam(teamId);
    const s = readSubject(subject);
    await assertAllowed(actor, 'team:members.manage', teamRef(team.id));
    const why = await structuralLink(team.id, s, this.SubTeamsInParent);
    if (why) throw new InvalidArgument(`subject: ${why}`, 'subject');
    await execute(actor, [unlink(toAssignmentSubject(s), teamRef(team.id))], reasonOf('remove-member', actor));
  }

  async setTeamRole(actor: Principal, teamId: string, subject: TeamSubject, role: string): Promise<void> {
    const team = await liveTeam(teamId);
    const s = await this.memberSubject(team.id, subject);
    const r = readRole(role);
    await assertAllowed(actor, 'team:roles.manage', teamRef(team.id));
    const subjectRef = toAssignmentSubject(s);
    // Revoke first: the guard judges the removal (ranks, keepHolders) before the new role exists.
    await execute(actor, [unlink(subjectRef, teamRef(team.id)), { kind: 'assignment.grant', subject: subjectRef, role: r, scope: teamRef(team.id) }], reasonOf('set-role', actor));
  }

  async transferOwnership(actor: Principal, teamId: string, to: PrincipalRef, opts: { readonly keepAs?: string | null } = {}): Promise<void> {
    const team = await liveTeam(teamId);
    const target = readSubject(to, 'to');
    if ('group' in target || 'team' in target) throw new InvalidArgument('to must be a principal { type, id }', 'to');
    if (isSystem(actor)) throw new InvalidArgument('actor: SYSTEM owns nothing to hand over; use setTeamRole', 'actor');
    const keepAs = opts.keepAs === undefined ? TEAM_ADMIN_ROLE : opts.keepAs === null ? null : readRole(opts.keepAs, 'keepAs');
    await assertAllowed(actor, 'team:ownership.transfer', teamRef(team.id));
    if (target.type === actor.type && target.id === actor.id) return;
    const scope = teamRef(team.id);
    const self: PrincipalRef = { type: actor.type, id: actor.id };
    const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject: target, role: TEAM_OWNER_ROLE, scope }];
    if (keepAs !== null && keepAs !== TEAM_OWNER_ROLE && !(await holdsAt(self, keepAs, scope))) commands.push({ kind: 'assignment.grant', subject: self, role: keepAs, scope });
    commands.push({ kind: 'assignment.revokeWhere', scope, subject: self, role: TEAM_OWNER_ROLE });
    // The guard runs per command: the new owner exists before the old one goes (keepHolders), and the actor's own
    // keepAs grant is judged while the actor is still owner (escalation).
    await execute(actor, commands, reasonOf('transfer', actor));
  }

  async grant(actor: Principal, subject: TeamSubject, role: string, scope: ResourceRef): Promise<void> {
    const s = readSubject(subject);
    const r = readRole(role);
    const at = readScope(scope);
    await assertSubjectExists(s);
    await this.assertRolesAt(actor, at);
    await execute(actor, [{ kind: 'assignment.grant', subject: toAssignmentSubject(s), role: r, scope: at }], reasonOf('grant', actor));
  }

  async revoke(actor: Principal, subject: TeamSubject, role: string, scope: ResourceRef): Promise<void> {
    const s = readSubject(subject);
    const r = readRole(role);
    const at = readScope(scope);
    await this.assertRolesAt(actor, at);
    if (at.type === TEAM_TYPE && r === TEAM_MEMBER_ROLE) {
      const why = await structuralLink(String(at.id), s, this.SubTeamsInParent);
      if (why) throw new InvalidArgument(`subject: ${why}`, 'subject');
    }
    await execute(actor, [{ kind: 'assignment.revokeWhere', scope: at, subject: toAssignmentSubject(s), role: r }], reasonOf('revoke', actor));
  }
```

Add to the helpers section:

```ts
  protected async memberSubject(teamId: string, subject: unknown): Promise<TeamSubject> {
    const s = readSubject(subject);
    if ('team' in s && s.team === teamId) throw new InvalidArgument('subject: a team cannot be its own member', 'subject');
    await assertSubjectExists(s);
    return s;
  }

  /** At teams and groups teams decide; at any other scope AuthzAdmin's permission for that scope type does. */
  protected async assertRolesAt(actor: Principal, at: ResourceRef): Promise<void> {
    if (at.type === TEAM_TYPE) await liveTeam(at.id, 'scope');
    else if (at.type === GROUP_TYPE) await liveGroup(at.id, 'scope');
    else return;
    await assertAllowed(actor, 'team:roles.manage', at);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/members.test.ts test/teams/team-service.test.ts`
Expected: PASS, `16 passing`. `last_holder` missing (the batch succeeds) means L8's `keepHolders` is not active: check `authz.admin.guard.keepHolders` reaches `DefaultAdminGuard` (contract issue 8), do not work around it in teams.

- [ ] **Step 6: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): team members, roles, ownership transfer and cross-team grants"
```

---

### Task 7: `GroupService`: groups, nested groups, moves, members

**Files:**
- Create: `packages/teams/src/services/group-service.ts`
- Modify: `packages/teams/src/index.ts`
- Test: `packages/teams/test/groups/group-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2-6 (`groupParent`, `groupLineage`, `liveGroup`, `linkGroup`, `unlinkGroup`, `listMembers`, `groupSet`, subjects), L4 `.accessible()` and `.within(ref: ResourceRef)` on model selects.
- Produces: `DefaultGroupService` (`@Singleton() @Injectable(GroupService)`) implementing every `GroupService` method.
- Behaviour:
  - `createGroup` needs `group:create` at the team; the group's set is linked (SYSTEM, before the row is inserted; lane decision 12) into its parent group's set or the team's set.
  - `moveGroup` needs `group:update` at the group and, when the team changes, `group:create` at the target team; the whole subtree changes `team_id`; slugs must stay unique in the target team; the moved set loses every role at its old target and is linked at the new one.
  - `deleteGroup` needs `group:delete`; a group with sub-groups is refused (`InvalidArgument`, field `id`); authz-orm's delete clean-up forgets the group's scope (its assignments, and the rows of its member set elsewhere).
  - `addGroupMember`/`removeGroupMember` need `group:members.manage`: a principal through `set.addMember`/`set.removeMember` as the actor; a `{ group }` or `{ team }` subject through `assignment.grant`/`revokeWhere` of `group.member` as SYSTEM (AuthzAdmin maps `assignment.*` at groups to `team:roles.manage`, which a group manager lacks). A direct sub-group's structural link cannot be removed.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/groups/group-service.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';

import { GroupService, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('GroupService', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('creates groups and nested groups; membership flows up to the team', async () => {
    const { owner, team } = await ownedTeam();
    const outer = await groups.createGroup(owner, team.id, { slug: slug('outer'), name: 'Outer' });
    const inner = await groups.createGroup(owner, team.id, { slug: slug('inner'), name: 'Inner', parentId: outer.id });
    expect(inner).to.include({ teamId: team.id, parentId: outer.id });
    const u = person('u');
    await groups.addGroupMember(owner, inner.id, refOf(u));
    expect(await stack.authz.can(u, 'group:read', groupRef(inner.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:read', groupRef(outer.id))).to.equal(true);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:update', groupRef(inner.id))).to.equal(false);
    // Team roles cover the team's groups (scope tree).
    expect(await stack.authz.can(owner, 'group:update', groupRef(inner.id))).to.equal(true);
  });

  it('refuses a parent group of another team, a taken slug and a stranger', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const gb = await groups.createGroup(b.owner, b.team.id, { slug: slug('gb'), name: 'GB' });
    expect(await failure(groups.createGroup(a.owner, a.team.id, { slug: slug('x'), name: 'X', parentId: gb.id }))).to.be.instanceOf(InvalidArgument);
    const s = slug('same');
    await groups.createGroup(a.owner, a.team.id, { slug: s, name: 'S' });
    expect(await failure(groups.createGroup(a.owner, a.team.id, { slug: s, name: 'S2' }))).to.be.instanceOf(ResourceDuplicated);
    expect(await failure(groups.createGroup(person('stranger'), a.team.id, { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('a group manager manages members but not the team', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    const mgr = person('mgr');
    await teams.grant(owner, refOf(mgr), 'group.manager', groupRef(g.id));
    const u = person('u');
    await groups.addGroupMember(mgr, g.id, refOf(u));
    expect((await groups.members(mgr, g.id)).items.map((e) => e.subject)).to.deep.include(refOf(u));
    await groups.removeGroupMember(mgr, g.id, refOf(u));
    expect(await stack.authz.can(u, 'group:read', groupRef(g.id))).to.equal(false);
    expect(await failure(groups.createGroup(mgr, team.id, { slug: slug('x'), name: 'X' }))).to.be.instanceOf(AccessDenied);
  });

  it('a group of one team can be a member of another team’s group and hold roles on another team', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const ga = await groups.createGroup(a.owner, a.team.id, { slug: slug('ga'), name: 'GA' });
    const gb = await groups.createGroup(b.owner, b.team.id, { slug: slug('gb'), name: 'GB' });
    const u = person('u');
    await groups.addGroupMember(a.owner, ga.id, refOf(u));
    await groups.addGroupMember(b.owner, gb.id, { group: ga.id });
    expect(await stack.authz.can(u, 'group:read', groupRef(gb.id))).to.equal(true);
    await teams.grant(b.owner, { group: ga.id }, 'team.admin', teamRef(b.team.id));
    expect(await stack.authz.can(u, 'team:update', teamRef(b.team.id))).to.equal(true);
    await groups.removeGroupMember(b.owner, gb.id, { group: ga.id });
    expect(await stack.authz.can(u, 'group:read', groupRef(gb.id))).to.equal(true);
  });

  it('moves a group inside its team and to another team; the subtree follows and the links move', async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const top = await groups.createGroup(a.owner, a.team.id, { slug: slug('top'), name: 'Top' });
    const g = await groups.createGroup(a.owner, a.team.id, { slug: slug('g'), name: 'G' });
    const child = await groups.createGroup(a.owner, a.team.id, { slug: slug('child'), name: 'Child', parentId: g.id });
    const u = person('u');
    await groups.addGroupMember(a.owner, child.id, refOf(u));

    expect((await groups.moveGroup(a.owner, g.id, { parentId: top.id })).parentId).to.equal(top.id);
    expect(await stack.authz.can(u, 'group:read', groupRef(top.id))).to.equal(true);
    expect(await failure(groups.moveGroup(a.owner, top.id, { parentId: child.id }))).to.be.instanceOf(InvalidArgument);

    // The owner of A is not an admin of B: group:create there is refused.
    expect(await failure(groups.moveGroup(a.owner, g.id, { teamId: b.team.id, parentId: null }))).to.be.instanceOf(AccessDenied);
    await teams.addTeamMember(b.owner, b.team.id, refOf(a.owner), 'team.admin');
    const moved = await groups.moveGroup(a.owner, g.id, { teamId: b.team.id, parentId: null });
    expect(moved).to.include({ teamId: b.team.id, parentId: null });
    expect((await groups.getGroup(a.owner, child.id)).teamId).to.equal(b.team.id);
    expect(await stack.authz.can(u, 'team:read', teamRef(b.team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'team:read', teamRef(a.team.id))).to.equal(false);
    expect(await stack.authz.can(u, 'group:read', groupRef(top.id))).to.equal(false);
  });

  it('deletes a leaf group; refuses one with sub-groups; lists with .within(team)', async () => {
    const { owner, team } = await ownedTeam();
    const p = await groups.createGroup(owner, team.id, { slug: slug('p'), name: 'P' });
    const c = await groups.createGroup(owner, team.id, { slug: slug('c'), name: 'C', parentId: p.id });
    expect((await groups.listGroups(owner, team.id)).items.map((g) => g.name)).to.deep.equal(['C', 'P']);
    expect(await groups.listGroups(owner, team.id, { limit: 1, offset: 1 })).to.deep.include({ total: 2 });
    expect((await groups.listGroups(owner, team.id, { limit: 1, offset: 1 })).items.map((g) => g.name)).to.deep.equal(['P']);
    expect(await failure(groups.deleteGroup(owner, p.id))).to.be.instanceOf(InvalidArgument);
    const u = person('u');
    await groups.addGroupMember(owner, c.id, refOf(u));
    await groups.deleteGroup(owner, c.id);
    expect(await failure(groups.getGroup(owner, c.id))).to.be.instanceOf(ResourceNotFound);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(false);
    expect(await stack.rows('authz_assignment', { scope_type: 'group', scope_id: c.id })).to.deep.equal([]);
    expect(await groups.listGroups(person('stranger'), team.id)).to.deep.equal({ items: [], total: 0 });
  });

  it('an archived team’s groups are frozen', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    await teams.archiveTeam(owner, team.id);
    expect(await failure(groups.updateGroup(owner, g.id, { name: 'X' }))).to.be.instanceOf(AccessDenied);
    expect(await failure(groups.createGroup(owner, team.id, { slug: slug('n'), name: 'N' }))).to.be.instanceOf(AccessDenied);
    expect((await groups.getGroup(owner, g.id)).name).to.equal('G');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/groups/group-service.test.ts`
Expected: FAIL, `DI.resolve(GroupService)` throws (no implementation registered).

- [ ] **Step 3: `src/services/group-service.ts`**

```ts
import { randomUUID } from 'node:crypto';

import { SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { GROUP_MEMBER_ROLE, GroupService } from '../api.js';
import type { CreateGroupInput, GroupView, MemberEntry, MoveGroupInput, Page, Paged, TeamSubject, UpdateGroupInput } from '../api.js';
import { asSystem, assertAllowed, execute, teamsDriver } from '../host.js';
import { groupLineage, groupParent, liveGroup, liveTeam } from '../lookup.js';
import { Group } from '../models/Group.js';
import { groupRef, teamRef } from '../refs.js';
import { assertSubjectExists, readSubject, toAssignmentSubject } from '../subjects.js';
import { readDescription, readName, readPage, readSlug } from '../validate.js';
import { toGroupView } from '../views.js';
import { createdBy, pageOf, reasonOf, undoOnFailure } from './common.js';
import { linkGroup, unlinkGroup } from './links.js';
import { listMembers } from './members.js';

@Singleton()
@Injectable(GroupService)
export class DefaultGroupService extends GroupService {
  async createGroup(actor: Principal, teamId: string, input: CreateGroupInput): Promise<GroupView> {
    const team = await liveTeam(teamId);
    const slug = readSlug(input?.slug);
    const name = readName(input?.name);
    const description = readDescription(input?.description);
    const parent = input?.parentId == null ? null : await groupParent(team.id, input.parentId);
    await assertAllowed(actor, 'group:create', teamRef(team.id));
    await this.assertSlugFree(team.id, [slug]);

    const now = DateTime.now();
    const group = new Group({ id: randomUUID(), team_id: team.id, parent_id: parent?.id ?? null, slug, name, description, created_by: createdBy(actor), created_at: now, updated_at: now });
    // Authz first (lane decision 12): a crash after it leaves an inert link, never a group outside its team's set.
    await execute(SYSTEM, [linkGroup(group)], reasonOf('create-group', actor));
    await undoOnFailure(
      () => asSystem(() => group.insert()),
      () => execute(SYSTEM, [unlinkGroup(group)], reasonOf('create-group-undo', actor)),
    );
    return toGroupView(group);
  }

  async getGroup(actor: Principal, id: string): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:read', groupRef(group.id));
    return toGroupView(group);
  }

  async listGroups(actor: Principal, teamId: string, page?: Page): Promise<Paged<GroupView>> {
    const team = await liveTeam(teamId);
    return pageOf(actor, readPage(page), () => Group.query().accessible('group:read').within(teamRef(team.id)), (g: Group) => toGroupView(g));
  }

  async updateGroup(actor: Principal, id: string, input: UpdateGroupInput): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:update', groupRef(group.id));
    const changes: Partial<Group> = {};
    if (input?.slug !== undefined) {
      const slug = readSlug(input.slug);
      if (slug !== group.slug) {
        await this.assertSlugFree(group.team_id, [slug]);
        changes.slug = slug;
      }
    }
    if (input?.name !== undefined) changes.name = readName(input.name);
    if (input?.description !== undefined) changes.description = readDescription(input.description);
    if (Object.keys(changes).length > 0) await asSystem(() => group.update({ ...changes, updated_at: DateTime.now() }));
    return toGroupView(await liveGroup(group.id));
  }

  async moveGroup(actor: Principal, id: string, to: MoveGroupInput): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    const target = await liveTeam(to?.teamId ?? group.team_id);
    const parent = to?.parentId == null ? null : await groupParent(target.id, to.parentId);
    await assertAllowed(actor, 'group:update', groupRef(group.id));
    const crossTeam = target.id !== group.team_id;
    if (crossTeam) await assertAllowed(actor, 'group:create', teamRef(target.id));
    if ((parent?.id ?? null) === (group.parent_id ?? null) && !crossTeam) return toGroupView(group);
    if (parent && (await groupLineage(parent.id)).includes(group.id)) throw new InvalidArgument('parentId: a group cannot move below itself', 'parentId');

    const subtree = crossTeam ? await this.subtree(group) : [group];
    if (crossTeam) await this.assertSlugFree(target.id, subtree.map((g) => g.slug));
    const before = { team_id: group.team_id, parent_id: group.parent_id ?? null };
    const after = { team_id: target.id, parent_id: parent?.id ?? null };

    const driver = await teamsDriver();
    // Both @Parent columns in one transaction: authz-orm rewrites the closure of every moved row.
    const write = (from: typeof before, next: typeof after) =>
      asSystem(() =>
        driver.transaction(async () => {
          if (from.team_id !== next.team_id) await Group.update({ team_id: next.team_id }).whereIn('id', subtree.map((g) => g.id));
          await Group.update({ parent_id: next.parent_id }).where('id', group.id);
        }),
      );
    await write(before, after);
    const commands: AuthzCommand[] = [unlinkGroup({ id: group.id, ...before }), linkGroup({ id: group.id, ...after })];
    await undoOnFailure(
      () => execute(SYSTEM, commands, reasonOf('move-group', actor)),
      () => write(after, before),
    );
    return toGroupView(await liveGroup(group.id));
  }

  async deleteGroup(actor: Principal, id: string): Promise<void> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:delete', groupRef(group.id));
    if (await asSystem(() => Group.where('parent_id', group.id).first())) throw new InvalidArgument('id: the group has sub-groups; move or delete them first', 'id');
    await this.beforeDelete(group);
    // authz-orm's delete clean-up forgets the group scope in the same statement's transaction.
    await asSystem(() => group.destroy());
  }

  async members(actor: Principal, groupId: string, page?: Page): Promise<Paged<MemberEntry>> {
    const group = await liveGroup(groupId);
    await assertAllowed(actor, 'group:read', groupRef(group.id));
    return listMembers(actor, groupRef(group.id), page);
  }

  async addGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void> {
    const group = await liveGroup(groupId);
    const s = readSubject(subject);
    if ('group' in s && s.group === group.id) throw new InvalidArgument('subject: a group cannot be its own member', 'subject');
    await assertSubjectExists(s);
    await assertAllowed(actor, 'group:members.manage', groupRef(group.id));
    const set = { role: GROUP_MEMBER_ROLE, scope: groupRef(group.id) };
    if ('group' in s || 'team' in s) {
      await execute(SYSTEM, [{ kind: 'assignment.grant', subject: toAssignmentSubject(s), role: GROUP_MEMBER_ROLE, scope: set.scope }], reasonOf('add-group-member', actor));
      return;
    }
    await execute(actor, [{ kind: 'set.addMember', set, member: s }], reasonOf('add-group-member', actor));
  }

  async removeGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void> {
    const group = await liveGroup(groupId);
    const s = readSubject(subject);
    await assertAllowed(actor, 'group:members.manage', groupRef(group.id));
    const set = { role: GROUP_MEMBER_ROLE, scope: groupRef(group.id) };
    if ('group' in s || 'team' in s) {
      if ('group' in s) {
        const child = await asSystem(() => Group.where('id', s.group).first());
        if (child && child.parent_id === group.id) throw new InvalidArgument('subject: a sub-group is a member through the group structure; move it instead', 'subject');
      }
      await execute(SYSTEM, [{ kind: 'assignment.revokeWhere', scope: set.scope, subject: toAssignmentSubject(s), role: GROUP_MEMBER_ROLE }], reasonOf('remove-group-member', actor));
      return;
    }
    await execute(actor, [{ kind: 'set.removeMember', set, member: s }], reasonOf('remove-group-member', actor));
  }

  /** Rows that reference the group and are not authz data; Task 9 deletes its invitations here. */
  protected async beforeDelete(_group: Group): Promise<void> {}

  protected async assertSlugFree(teamId: string, slugs: readonly string[]): Promise<void> {
    if (slugs.length === 0) return;
    const taken = (await asSystem(() => Group.query().where('team_id', teamId).whereIn('slug', [...slugs]))) as Group[];
    if (taken.length > 0) throw new ResourceDuplicated(`group slug ${taken[0].slug} is taken in team ${teamId}`);
  }

  /** The group and every group below it. */
  protected async subtree(group: Group): Promise<Group[]> {
    const all = (await asSystem(() => Group.query().where('team_id', group.team_id))) as Group[];
    const out = [group];
    for (let i = 0; i < out.length; i++) out.push(...all.filter((g) => g.parent_id === out[i].id));
    return out;
  }
}
```

`src/index.ts` gains:

```ts
export * from './services/group-service.js';
```

- [ ] **Step 4: Run the test**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/groups/group-service.test.ts`
Expected: PASS, `7 passing`. If the cross-team move leaves `u` reading team A, the membership closure was not refreshed for the members below the moved set: that is L6 (move of a group between teams keeps the closure right, teams §10), report it with the case.

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): GroupService with nested groups, moves across teams and group members"
```

---

### Task 8: Delete, restore, purge and `TeamPurged`

**Files:**
- Modify: `packages/teams/src/services/team-service.ts` (replace the four Task 8 stubs, add helpers)
- Test: `packages/teams/test/teams/delete.test.ts`

**Interfaces:**
- Consumes: L3's delete clean-up (a model delete of an `@AccessResource` row forgets its scope inside the statement's transaction with `DbAuthzAdminBackend`, membership closure refreshed by L6's `RbacScopeForgetter`, ancestor rows removed); `AuthzEventSink` (core); Tasks 2-7.
- Produces:
  - `TeamService.deleteTeam`, `restoreTeam`, `purgeTeam`, `purgeDue` (signatures in `api.ts`).
  - Protected `DefaultTeamService.purge(team: Team): Promise<readonly string[]>` (shared by `purgeTeam` and `purgeDue`) and hook `beforePurge(team: Team): Promise<void>` (no-op here; Task 9 deletes the team's invitations in it).
  - Event `{ type: 'TeamPurged', domain, actor: { type: SYSTEM.type, id: SYSTEM.id }, at, data: { team, slug, teams, groups } }` to every `AuthzEventSink` of the teams domain, after the purge commits.
- Behaviour: `deleteTeam` needs `team:delete` (an archived team too: the archived policies do not deny `team:delete`), refuses a team with live sub-teams, sets `deleted_at` and the `archived` attribute (writes freeze during the grace). `restoreTeam` needs `team:delete`, refuses when the parent is deleted, and puts the attribute back to `archived_at !== null`. `purgeTeam(actor, id)` needs `team:delete` and refuses a live team (`InvalidOperation`); `purgeDue(now)` runs without an actor. A purge deletes, in one ORM transaction, the sub-teams (recursively), the groups deepest first and the team, each through its model so authz-orm forgets the scopes.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/teams/delete.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceNotFound } from '@spinajs/exceptions';

import { GroupService, TeamService } from '../../src/index.js';
import { teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

describe('TeamService: delete, restore, purge', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
  });

  it('soft delete hides the team and freezes it; restore brings it back', async () => {
    const owner = await teamCreator();
    const t = await teams.createTeam(owner, { slug: slug('d'), name: 'D' });
    await teams.deleteTeam(owner, t.id);
    expect(await failure(teams.getTeam(owner, t.id))).to.be.instanceOf(ResourceNotFound);
    expect((await teams.listTeams(owner)).items.map((x) => x.id)).to.not.include(t.id);
    expect(await stack.authz.can(owner, 'team:update', teamRef(t.id))).to.equal(false);
    const back = await teams.restoreTeam(owner, t.id);
    expect(back.deletedAt).to.equal(null);
    expect((await teams.updateTeam(owner, t.id, { name: 'Back' })).name).to.equal('Back');
    // Restoring a live team is a no-op that checks nothing.
    expect((await teams.restoreTeam(person('stranger'), t.id)).id).to.equal(t.id);
  });

  it('refuses a team with live sub-teams and a stranger; deletes an archived team without unarchiving', async () => {
    const owner = await teamCreator();
    const p = await teams.createTeam(owner, { slug: slug('p'), name: 'P' });
    const c = await teams.createTeam(owner, { slug: slug('c'), name: 'C', parentId: p.id });
    const g = await groups.createGroup(owner, c.id, { slug: slug('g'), name: 'G' });
    expect(await failure(teams.deleteTeam(owner, p.id))).to.be.instanceOf(InvalidArgument);
    expect(await failure(teams.deleteTeam(person('stranger'), c.id))).to.be.instanceOf(AccessDenied);
    await teams.archiveTeam(owner, c.id);
    // teams.archived.delete covers groups, not the team.
    expect(await failure(groups.deleteGroup(owner, g.id))).to.be.instanceOf(AccessDenied);
    await teams.deleteTeam(owner, c.id);
    await teams.deleteTeam(owner, p.id);
    expect(await failure(teams.restoreTeam(owner, c.id))).to.be.instanceOf(InvalidArgument);
    const back = await teams.restoreTeam(owner, p.id);
    expect(back.deletedAt).to.equal(null);
    expect((await teams.restoreTeam(owner, c.id)).archivedAt).to.be.instanceOf(Date);
    expect(await stack.authz.can(owner, 'team:update', teamRef(c.id))).to.equal(false);
  });

  it('purges after the grace: rows, scopes, memberships and ancestors go; TeamPurged is published', async () => {
    const owner = await teamCreator();
    const p = await teams.createTeam(owner, { slug: slug('pp'), name: 'PP' });
    const c = await teams.createTeam(owner, { slug: slug('pc'), name: 'PC', parentId: p.id });
    const outer = await groups.createGroup(owner, c.id, { slug: slug('o'), name: 'O' });
    const inner = await groups.createGroup(owner, c.id, { slug: slug('i'), name: 'I', parentId: outer.id });
    const u = person('u');
    await groups.addGroupMember(owner, inner.id, refOf(u));
    await teams.deleteTeam(owner, c.id);
    await teams.deleteTeam(owner, p.id);

    expect(await teams.purgeDue(new Date())).to.deep.equal([]);
    expect(await failure(teams.purgeTeam(owner, randomUUID()))).to.be.instanceOf(ResourceNotFound);
    const live = await teams.createTeam(owner, { slug: slug('live'), name: 'Live' });
    expect(await failure(teams.purgeTeam(owner, live.id))).to.be.instanceOf(InvalidOperation);
    expect(await failure(teams.purgeTeam(person('stranger'), p.id))).to.be.instanceOf(AccessDenied);

    const purged = await teams.purgeDue(new Date(Date.now() + 31 * DAY));
    expect(purged).to.include.members([p.id, c.id]);
    expect(await stack.rows('teams', { id: p.id })).to.deep.equal([]);
    expect(await stack.rows('teams', { id: c.id })).to.deep.equal([]);
    expect(await stack.rows('groups', { team_id: c.id })).to.deep.equal([]);
    expect(await stack.rows('authz_assignment', { scope_type: 'team', scope_id: p.id })).to.deep.equal([]);
    expect(await stack.rows('authz_resource_ancestor', { resource_type: 'group', resource_id: inner.id })).to.deep.equal([]);
    expect((await teams.teamsOf(refOf(u))).teams).to.deep.equal([]);

    const event = stack.events.events.find((e) => e.type === 'TeamPurged' && e.data.team === p.id);
    expect(event?.data).to.deep.include({ team: p.id, slug: p.slug });
    expect(event?.data.teams).to.deep.equal([p.id, c.id]);
    expect(event?.data.groups).to.have.members([outer.id, inner.id]);

    // The slug is free again.
    expect((await teams.createTeam(owner, { slug: p.slug, name: 'Again' })).slug).to.equal(p.slug);
  });

  it('an owner purges a deleted team at once', async () => {
    const owner = await teamCreator();
    const t = await teams.createTeam(owner, { slug: slug('now'), name: 'Now' });
    await teams.deleteTeam(owner, t.id);
    expect(await teams.purgeTeam(owner, t.id)).to.deep.equal([t.id]);
    expect(await stack.rows('teams', { id: t.id })).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/delete.test.ts`
Expected: FAIL, `MethodNotImplemented: DefaultTeamService.deleteTeam: lane L14 Task 8`.

- [ ] **Step 3: Replace the Task 8 stubs**

Imports in `src/services/team-service.ts`: add `AuthzEventSink` to the `@spinajs/authz` value import and `AuthzEvent` to its type import; `InvalidOperation` to the `@spinajs/exceptions` import and remove `MethodNotImplemented` from it; add:

```ts
import { Log, Logger } from '@spinajs/log';

import { TEAM_PURGED_EVENT } from '../api.js';
import { domainContainer, teamsDomain, teamsDriver } from '../host.js';
import { anyTeam } from '../lookup.js';
import { Group } from '../models/Group.js';
import { dateOf } from '../views.js';
```

(merge into the existing import lines of the same modules.)

Add the logger next to the `@Config` fields:

```ts
  @Logger('teams')
  protected Log: Log;
```

Replace the four methods under `// ---- Task 8 ----` with:

```ts
  // ---- Task 8 ----

  async deleteTeam(actor: Principal, id: string): Promise<void> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:delete', teamRef(team.id));
    if (await asSystem(() => Team.query().where('parent_id', team.id).whereNull('deleted_at').first())) {
      throw new InvalidArgument('id: the team has live sub-teams; move or delete them first', 'id');
    }
    await asSystem(() => team.update({ deleted_at: DateTime.now() }));
    // Frozen during the grace: the archived deny policy covers the team and its groups.
    await undoOnFailure(
      () => execute(SYSTEM, [archivedAttribute(team.id, true)], reasonOf('delete', actor)),
      () => asSystem(() => team.update({ deleted_at: null })),
    );
  }

  async restoreTeam(actor: Principal, id: string): Promise<TeamView> {
    const team = await anyTeam(id, 'id');
    if (!team.deleted_at) return toTeamView(team);
    if (team.parent_id) {
      await liveTeam(team.parent_id, 'parentId').catch(() => {
        throw new InvalidArgument('id: the parent team is deleted; restore it first', 'id');
      });
    }
    await assertAllowed(actor, 'team:delete', teamRef(team.id));
    const deletedAt = team.deleted_at;
    await asSystem(() => team.update({ deleted_at: null }));
    await undoOnFailure(
      () => execute(SYSTEM, [archivedAttribute(team.id, team.archived_at !== null && team.archived_at !== undefined)], reasonOf('restore', actor)),
      () => asSystem(() => team.update({ deleted_at: deletedAt })),
    );
    return toTeamView(await liveTeam(team.id));
  }

  async purgeTeam(actor: Principal, id: string): Promise<readonly string[]> {
    const team = await anyTeam(id, 'id');
    if (!team.deleted_at) throw new InvalidOperation(`team ${team.id} is not deleted`);
    await assertAllowed(actor, 'team:delete', teamRef(team.id));
    return this.purge(team);
  }

  async purgeDue(now: Date = new Date()): Promise<readonly string[]> {
    const cutoff = now.getTime() - this.GraceDays * 86_400_000;
    const deleted = (await asSystem(() => Team.query().whereNotNull('deleted_at'))) as Team[];
    const due = deleted.filter((t) => (dateOf(t.deleted_at)?.getTime() ?? Infinity) <= cutoff);
    const dueIds = new Set(due.map((t) => t.id));
    const out: string[] = [];
    for (const t of due) {
      // Purged with its parent, which recurses into it.
      if (t.parent_id && dueIds.has(t.parent_id)) continue;
      out.push(...(await this.purge(t)));
    }
    return Object.freeze(out);
  }

  protected async purge(team: Team): Promise<readonly string[]> {
    const removed = { teams: [] as string[], groups: [] as string[] };
    const driver = await teamsDriver();
    await asSystem(() => driver.transaction(() => this.purgeTree(team, removed)));
    const teams = [team.id, ...removed.teams.filter((t) => t !== team.id)];
    await this.publish({
      type: TEAM_PURGED_EVENT,
      domain: await teamsDomain(),
      actor: { type: SYSTEM.type, id: SYSTEM.id },
      at: new Date(),
      data: Object.freeze({ team: team.id, slug: team.slug, teams, groups: removed.groups }),
    });
    return Object.freeze(teams);
  }
```

Add to the helpers section:

```ts
  /** Rows that reference the team and are not authz data; Task 9 deletes the team's invitations here. */
  protected async beforePurge(_team: Team): Promise<void> {}

  /** Children before parents, each through its model so authz-orm forgets the scope (teams design §7). */
  protected async purgeTree(team: Team, removed: { teams: string[]; groups: string[] }): Promise<void> {
    for (const child of (await Team.query().where('parent_id', team.id)) as Team[]) await this.purgeTree(child, removed);
    await this.beforePurge(team);
    const groups = (await Group.query().where('team_id', team.id)) as Group[];
    const byId = new Map(groups.map((g) => [g.id, g]));
    const depth = (g: Group): number => {
      let d = 0;
      for (let p = g.parent_id; p && byId.has(p); p = byId.get(p)!.parent_id) d++;
      return d;
    };
    for (const g of [...groups].sort((a, b) => depth(b) - depth(a))) {
      await g.destroy();
      removed.groups.push(g.id);
    }
    await team.destroy();
    removed.teams.push(team.id);
  }

  /** After commit; a sink that fails is logged, the purge stays. */
  protected async publish(event: AuthzEvent): Promise<void> {
    const container = await domainContainer();
    if (!container.hasRegistered(AuthzEventSink)) return;
    for (const sink of (await container.resolve(Array.chainOf(AuthzEventSink))) as AuthzEventSink[]) {
      try {
        await sink.publish([event]);
      } catch (e) {
        this.Log.warn(`${event.type} of team ${String(event.data.team)} was not delivered to ${sink.constructor.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/teams/delete.test.ts test/teams/team-service.test.ts test/teams/members.test.ts`
Expected: PASS, `20 passing`. Assignment rows left at a purged scope mean the delete clean-up did not run for a model delete: that is L3 Task 5; report it with the case.

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): soft delete, restore, purge after grace and TeamPurged"
```

---

### Task 9: Invitations: tables, token, mail, create, list, revoke, resend

**Files:**
- Create: `packages/teams/src/migrations/TeamsInvitations_2026_10_14_00_01_00.ts`, `src/models/TeamInvitation.ts`, `src/invitations/token.ts`, `src/invitations/mailer.ts`, `src/invitations/rows.ts`, `src/invitations/service.ts`, `src/invitations/index.ts`
- Modify: `src/migrations/index.ts`, `src/models/index.ts`, `src/index.ts`, `src/services/team-service.ts` (`beforePurge`), `src/services/group-service.ts` (`beforeDelete`), `test/support/db.ts` (`MIGRATIONS`), `test/support/stack.ts` (recording mailer)
- Test: `packages/teams/test/invitations/token.test.ts`, `test/invitations/mailer.test.ts`, `test/invitations/create.test.ts`

**Interfaces:**
- Consumes: Tasks 2-8; `EmailService.send(IEmail)`, `redactText(text, secrets)` (`@spinajs/email`); the HMAC pattern of `packages/authz-rbac/src/stores/db-link-store.ts` (`v1:` + hex HMAC-SHA256, 32 random bytes base64url, constant-time compare, secret of ≥ 32 characters read on every use).
- Produces:
  - Tables `team_invitations` (teams §6) and `team_invitation_uses` (unique `(invitation_id, principal)`, the design's PK); model `TeamInvitation`.
  - `src/invitations/token.ts`: `INVITATION_SECRET_KEY`, `INVITATION_TOKEN_MAX_LENGTH = 128`, `newInvitationToken(): string`, `invitationTokenHash(secret, token): string`, `readInvitationSecret(v): string`, `hashesEqual(a, b): boolean`.
  - `src/invitations/mailer.ts`: `EmailInvitationMailer` (`@Injectable(InvitationMailer)`, optional `deps: { email, options?, defaultConnection? }`), `InvitationMailOptions`.
  - `src/invitations/rows.ts`: `INVITATION_USES_TABLE`, `toInvitationView(i)`, `deleteInvitations(where: { team_id: string } | { group_id: string })`.
  - `src/invitations/service.ts`: `DefaultInvitationService` (`@Singleton() @Injectable(InvitationService)`) with `create`, `list`, `revoke`, `resend`; `accept` throws `MethodNotImplemented` until Task 10. Exports `acceptCommand(member: PrincipalRef, role, teamId, groupId): AuthzCommand`; protected `emailSource(): Promise<VerifiedEmailSource>` (throws `InvalidOperation` when the app registered none; Task 10 uses it too).
  - Test support: `RecordingInvitationMailer` (`sent`, `fail`), `AttributesEmailSource` (the app-side `VerifiedEmailSource` the stack registers: `attributes.email` when `attributes.emailVerified === true`), `TeamsStack.mailer`.

- [ ] **Step 1: Tables, model, test database**

`src/migrations/TeamsInvitations_2026_10_14_00_01_00.ts`:

```ts
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** Teams design §6, invitations. */
@Migration('default')
export class TeamsInvitations_2026_10_14_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('team_invitations', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('team_id', 36).notNull();
      table.string('group_id', 36);
      table.string('role', 128).notNull();
      table.string('email', 255);
      table.string('token_hash', 128).notNull().unique();
      table.int('max_uses');
      table.int('uses').notNull().default().value(0);
      table.dateTime('expires_at').notNull();
      table.dateTime('revoked_at');
      table.string('created_by', 100).notNull();
      table.dateTime('created_at').notNull();
      table.dateTime('last_sent_at');
      table.foreignKey('team_id').references('teams', 'id');
      table.foreignKey('group_id').references('groups', 'id');
    });

    await connection.schema().createTable('team_invitation_uses', (table) => {
      table.string('invitation_id', 36).notNull();
      table.string('principal', 200).notNull();
      table.dateTime('used_at').notNull();
      table.foreignKey('invitation_id').references('team_invitations', 'id');
    });

    // The design's PK(invitation_id, principal); a unique index works the same on every driver.
    await connection.index().unique().table('team_invitation_uses').name('team_invitation_uses_key').columns(['invitation_id', 'principal']);
    await connection.index().table('team_invitations').name('team_invitations_team').columns(['team_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('team_invitation_uses');
    await connection.schema().dropTable('team_invitations');
  }
}
```

`src/migrations/index.ts` gains `export * from './TeamsInvitations_2026_10_14_00_01_00.js';`.

`src/models/TeamInvitation.ts`:

```ts
import { Connection, CreatedAt, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('team_invitations')
export class TeamInvitation extends ModelBase<TeamInvitation> {
  @Primary()
  public id: string;

  public team_id: string;

  public group_id: string | null;

  public role: string;

  public email: string | null;

  public token_hash: string;

  public max_uses: number | null;

  public uses: number;

  @DT()
  public expires_at: DateTime;

  @DT()
  public revoked_at: DateTime | null;

  public created_by: string;

  @CreatedAt()
  public created_at: DateTime;

  @DT()
  public last_sent_at: DateTime | null;
}
```

`src/models/index.ts` gains `export * from './TeamInvitation.js';`.

In `test/support/db.ts`: change the import to `import { Teams_2026_10_14_00_00_00, TeamsInvitations_2026_10_14_00_01_00 } from '../../src/index.js';` and append `TeamsInvitations_2026_10_14_00_01_00,` to `MIGRATIONS` after `Teams_2026_10_14_00_00_00,`.

In `test/support/stack.ts`: add to the imports `import { InvitationMailer, VerifiedEmailSource } from '../../src/index.js';`, `import type { InvitationMail } from '../../src/index.js';` and `import type { Principal } from '@spinajs/authz';`; add the classes

```ts
/** What an app registers: teams ships no VerifiedEmailSource. */
export class AttributesEmailSource extends VerifiedEmailSource {
  async verifiedEmail(principal: Principal): Promise<string | undefined> {
    const a = principal.attributes ?? {};
    return a.emailVerified === true && typeof a.email === 'string' ? a.email : undefined;
  }
}
```

```ts
export class RecordingInvitationMailer extends InvitationMailer {
  readonly sent: InvitationMail[] = [];
  fail = false;

  async send(mail: InvitationMail): Promise<void> {
    if (this.fail) throw new Error('mail transport down');
    this.sent.push(mail);
  }
}
```

add `readonly mailer: RecordingInvitationMailer;` to `TeamsStack`; in `boot()`, after the event sink registration:

```ts
  const mailer = new RecordingInvitationMailer();
  root.register(testHost.instance(mailer)).as(InvitationMailer);
  root.register(testHost.instance(new AttributesEmailSource())).as(VerifiedEmailSource);
```

and return `{ ...db, authz, admin: authz.admin(), events, mailer, config }`.

- [ ] **Step 2: Write the failing tests**

`packages/teams/test/invitations/token.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';

import { hashesEqual, invitationTokenHash, newInvitationToken, readInvitationSecret } from '../../src/invitations/token.js';

const expect = chai.expect;
const SECRET = 'x'.repeat(32);

describe('invitation tokens', () => {
  it('are 32 random bytes, base64url, stored only as a keyed hash', () => {
    const a = newInvitationToken();
    expect(a).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(newInvitationToken()).to.not.equal(a);
    const h = invitationTokenHash(SECRET, a);
    expect(h).to.match(/^v1:[0-9a-f]{64}$/);
    expect(invitationTokenHash(SECRET, a)).to.equal(h);
    expect(invitationTokenHash('y'.repeat(32), a)).to.not.equal(h);
    expect(hashesEqual(h, invitationTokenHash(SECRET, a))).to.equal(true);
    expect(hashesEqual(h, 'v1:00')).to.equal(false);
  });

  it('needs a secret of at least 32 characters', () => {
    expect(readInvitationSecret(SECRET)).to.equal(SECRET);
    expect(() => readInvitationSecret(undefined)).to.throw(AuthzConfigError, /teams\.invitations\.secret/);
    expect(() => readInvitationSecret('short')).to.throw(AuthzConfigError);
  });
});
```

`packages/teams/test/invitations/mailer.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import type { EmailService, IEmail } from '@spinajs/email';
import { IOFail } from '@spinajs/exceptions';

import { EmailInvitationMailer } from '../../src/invitations/mailer.js';
import type { InvitationMail } from '../../src/index.js';

const expect = chai.expect;
const at = new Date('2026-10-21T12:00:00.000Z');

const mail = (token: string): InvitationMail => ({
  to: 'ann@example.com',
  team: { id: 't', parentId: null, slug: 'core', name: 'Core', description: null, archivedAt: null, deletedAt: null, createdBy: null, createdAt: at, updatedAt: at },
  group: null,
  role: 'team.member',
  token,
  expiresAt: at,
  invitedBy: { type: 'user', id: 'boss' },
});

describe('EmailInvitationMailer', () => {
  it('sends at once with the token and the link marked for redaction', async () => {
    const sent: IEmail[] = [];
    const email = { send: async (e: IEmail) => void sent.push(e) } as unknown as EmailService;
    await new EmailInvitationMailer({ email, options: { url: 'https://app.example/join', subject: 'Join' }, defaultConnection: 'smtp' }).send(mail('TOKEN'));
    expect(sent).to.have.length(1);
    const e = sent[0];
    expect(e).to.include({ connection: 'smtp', subject: 'Join', tag: 'teams-invitation' });
    expect(e.to).to.deep.equal(['ann@example.com']);
    expect(e.model).to.include({ Team: 'Core', Role: 'team.member', Token: 'TOKEN', AcceptUrl: 'https://app.example/join?token=TOKEN' });
    expect(e.redact).to.deep.equal(['TOKEN', 'https://app.example/join?token=TOKEN']);
    expect(e.text).to.match(/Core as team\.member/);
  });

  it('uses the configured template; without a url the mail carries the code', async () => {
    const sent: IEmail[] = [];
    const email = { send: async (e: IEmail) => void sent.push(e) } as unknown as EmailService;
    await new EmailInvitationMailer({ email, options: { template: './invite.pug' }, defaultConnection: 'smtp' }).send(mail('CODE'));
    expect(sent[0]).to.include({ template: './invite.pug', subject: 'You are invited to join a team' });
    expect(sent[0].text).to.equal(undefined);
    expect(sent[0].redact).to.deep.equal(['CODE']);
  });

  it('never lets the token reach the error', async () => {
    const email = {
      send: async () => {
        throw new Error('rejected SECRET-TOKEN');
      },
    } as unknown as EmailService;
    const e = await new EmailInvitationMailer({ email, defaultConnection: 'smtp' }).send(mail('SECRET-TOKEN')).catch((err: unknown) => err as Error);
    expect(e).to.be.instanceOf(IOFail);
    expect(e.message).to.not.include('SECRET-TOKEN');
  });
});
```

`packages/teams/test/invitations/create.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import { AccessDenied, AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceNotFound } from '@spinajs/exceptions';

import { DefaultInvitationService, GroupService, InvitationService, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { INVITATION_SECRET, teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;

describe('InvitationService: create, list, revoke, resend', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;
  let invitations: InvitationService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
    invitations = (await DI.resolve(InvitationService)) as InvitationService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'Core' }) };
  }

  it('creates a link invitation: the token once, only its hash stored', async () => {
    const { owner, team } = await ownedTeam();
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    expect(token).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation).to.include({ teamId: team.id, groupId: null, role: 'team.member', email: null, maxUses: null, uses: 0, revokedAt: null, lastSentAt: null });
    expect(invitation.expiresAt.getTime() - Date.now()).to.be.within(167 * 3600_000, 168 * 3600_000);
    const [row] = await stack.rows('team_invitations', { id: invitation.id });
    expect(String(row.token_hash)).to.match(/^v1:/);
    expect(JSON.stringify(row)).to.not.include(token);
  });

  it('mails an email invitation (one use by default) and records the send', async () => {
    const { owner, team } = await ownedTeam();
    const before = stack.mailer.sent.length;
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'Ann@Example.com', expiresInHours: 24 });
    expect(invitation).to.include({ email: 'ann@example.com', maxUses: 1 });
    expect(invitation.lastSentAt).to.be.instanceOf(Date);
    const sent = stack.mailer.sent.slice(before);
    expect(sent.map((m) => [m.to, m.token, m.team.id, m.role])).to.deep.equal([['ann@example.com', token, team.id, 'team.member']]);
  });

  it('refuses what the inviter could not grant, strangers, foreign groups and bad input', async () => {
    const { owner, team } = await ownedTeam();
    const admin = person('admin');
    await teams.addTeamMember(owner, team.id, refOf(admin), 'team.admin');
    const escalation = await failure(invitations.create(admin, { teamId: team.id, role: 'team.owner' }));
    expect(escalation).to.be.instanceOf(AuthzAdminFailure);
    expect((escalation as AuthzAdminFailure).code).to.equal('escalation');
    expect((await invitations.create(admin, { teamId: team.id, role: 'team.admin' })).invitation.role).to.equal('team.admin');
    expect(await failure(invitations.create(person('stranger'), { teamId: team.id, role: 'team.member' }))).to.be.instanceOf(AccessDenied);
    const other = await ownedTeam();
    const foreign = await groups.createGroup(other.owner, other.team.id, { slug: slug('g'), name: 'G' });
    expect(await failure(invitations.create(owner, { teamId: team.id, groupId: foreign.id, role: 'group.member' }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', maxUses: 0 }))).to.be.instanceOf(InvalidArgument);
    expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', expiresInHours: 0 }))).to.be.instanceOf(InvalidArgument);
    const mine = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    expect((await invitations.create(owner, { teamId: team.id, groupId: mine.id, role: 'group.member' })).invitation.groupId).to.equal(mine.id);
  });

  it('lists, revokes and resends (a new token each time)', async () => {
    const { owner, team } = await ownedTeam();
    const link = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const mail = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'bob@example.com' });
    const listed = await invitations.list(owner, team.id);
    expect(listed.items.map((i) => i.id)).to.have.members([link.invitation.id, mail.invitation.id]);
    expect(listed.total).to.equal(2);
    expect((await invitations.list(owner, team.id, { limit: 1, offset: 0 })).items).to.have.length(1);
    expect(await failure(invitations.list(person('stranger'), team.id))).to.be.instanceOf(AccessDenied);

    const other = await ownedTeam();
    expect(await failure(invitations.revoke(other.owner, other.team.id, link.invitation.id))).to.be.instanceOf(ResourceNotFound);
    expect(await failure(invitations.resend(other.owner, other.team.id, mail.invitation.id))).to.be.instanceOf(ResourceNotFound);

    const before = stack.mailer.sent.length;
    await invitations.resend(owner, team.id, mail.invitation.id);
    const resent = stack.mailer.sent.slice(before);
    expect(resent).to.have.length(1);
    expect(resent[0].token).to.not.equal(mail.token);
    expect(await failure(invitations.resend(owner, team.id, link.invitation.id))).to.be.instanceOf(InvalidArgument);

    await invitations.revoke(owner, team.id, link.invitation.id);
    const revoked = (await invitations.list(owner, team.id)).items.find((i) => i.id === link.invitation.id);
    expect(revoked?.revokedAt).to.be.instanceOf(Date);
  });

  it('refuses email invitations while the app registered no VerifiedEmailSource; links still work', async () => {
    const { owner, team } = await ownedTeam();
    class NoEmailSource extends DefaultInvitationService {
      protected override async emailSource(): Promise<never> {
        throw new InvalidOperation('test: no VerifiedEmailSource');
      }
    }
    const service = new NoEmailSource();
    expect(await failure(service.create(owner, { teamId: team.id, role: 'team.member', email: 'x@example.com' }))).to.be.instanceOf(InvalidOperation);
    expect((await service.create(owner, { teamId: team.id, role: 'team.member' })).invitation.email).to.equal(null);
  });

  it('a failed mail leaves no invitation; no secret, no invitation', async () => {
    const { owner, team } = await ownedTeam();
    stack.mailer.fail = true;
    try {
      expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'cy@example.com' }))).to.be.instanceOf(Error);
    } finally {
      stack.mailer.fail = false;
    }
    expect(await invitations.list(owner, team.id)).to.deep.equal({ items: [], total: 0 });

    stack.config.set(['teams', 'invitations', 'secret'], undefined);
    try {
      expect(await failure(invitations.create(owner, { teamId: team.id, role: 'team.member' }))).to.be.instanceOf(AuthzConfigError);
    } finally {
      stack.config.set(['teams', 'invitations', 'secret'], INVITATION_SECRET);
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/invitations/token.test.ts test/invitations/mailer.test.ts test/invitations/create.test.ts`
Expected: FAIL, `Cannot find module '../../src/invitations/token.js'`.

- [ ] **Step 4: `src/invitations/token.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AuthzConfigError } from '@spinajs/authz';

import { INVITATION_SECRET_MIN_LENGTH } from '../schema.js';

export const INVITATION_SECRET_KEY = 'teams.invitations.secret';
export const INVITATION_TOKEN_MAX_LENGTH = 128;
const TOKEN_BYTES = 32;

export const newInvitationToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/** `v1:<hex HMAC-SHA256(secret, token)>`; the prefix names the key so a rotation can add v2 (as share links do). */
export const invitationTokenHash = (secret: string, token: string): string => `v1:${createHmac('sha256', secret).update(token, 'utf8').digest('hex')}`;

/** Read on every use: the service resolves before an app sets the secret, and a runtime set skips the schema. */
export function readInvitationSecret(v: unknown): string {
  if (typeof v !== 'string' || v.length < INVITATION_SECRET_MIN_LENGTH) {
    throw new AuthzConfigError(`${INVITATION_SECRET_KEY} must be set to hash invitation tokens: a string of at least ${INVITATION_SECRET_MIN_LENGTH} characters`);
  }
  return v;
}

/** Defence in depth: the row was found by this hash; the keyed hash is what makes the indexed lookup timing-safe. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
```

- [ ] **Step 5: `src/invitations/mailer.ts`**

`src/invitations/mailer.ts`:

```ts
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { EmailService, redactText } from '@spinajs/email';
import type { IEmail } from '@spinajs/email';
import { IOFail, InvalidOperation } from '@spinajs/exceptions';

import { InvitationMailer } from '../api.js';
import type { InvitationMail } from '../api.js';
import { TEAMS_DEFAULTS } from '../schema.js';

/** `teams.invitations` keys the mailer reads. */
export interface InvitationMailOptions {
  readonly template?: string;
  readonly subject?: string;
  /** The page that accepts; the token is added as `?token=`. */
  readonly url?: string;
  readonly connection?: string;
}

export interface EmailInvitationMailerDeps {
  readonly email: EmailService;
  readonly options?: InvitationMailOptions;
  readonly defaultConnection?: string;
}

function acceptUrl(base: string | undefined, token: string): string {
  if (!base) return '';
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Sends at once and never queues: the token is a secret, so it and the link go into `redact`, which keeps them out
 * of queued payloads, the EmailSent event, logs and errors.
 */
@Injectable(InvitationMailer)
export class EmailInvitationMailer extends InvitationMailer {
  @Config('teams.invitations', { defaultValue: {} })
  protected Options: InvitationMailOptions;

  @Config('email.defaultConnection')
  protected DefaultConnection: string;

  /** With `deps`, neither the configuration nor the container is used. */
  constructor(protected readonly Deps?: EmailInvitationMailerDeps) {
    super();
  }

  async send(mail: InvitationMail): Promise<void> {
    const options = (this.Deps ? this.Deps.options : this.Options) ?? {};
    const link = acceptUrl(options.url, mail.token);
    const secrets = link ? [mail.token, link] : [mail.token];
    try {
      const connection = options.connection || (this.Deps ? this.Deps.defaultConnection : this.DefaultConnection);
      if (!connection) throw new InvalidOperation('set teams.invitations.connection or email.defaultConnection');
      const service = this.Deps ? this.Deps.email : ((await DI.resolve(EmailService)) as EmailService);
      await service.send(this.compose(mail, options, connection, link, secrets));
    } catch (err) {
      // No cause: anything hanging off the original error may hold the token.
      throw new IOFail(`The invitation mail was not sent: ${redactText(err instanceof Error ? err.message : String(err), secrets)}`);
    }
  }

  protected compose(mail: InvitationMail, options: InvitationMailOptions, connection: string, link: string, secrets: readonly string[]): IEmail {
    const where = mail.group ? `${mail.team.name} / ${mail.group.name}` : mail.team.name;
    const text = [`You are invited to join ${where} as ${mail.role}.`, link ? `Accept the invitation:\n${link}` : `Your invitation code:\n${mail.token}`, `It expires at ${mail.expiresAt.toISOString()}.`].join('\n\n');
    return {
      to: [mail.to],
      connection,
      subject: options.subject || TEAMS_DEFAULTS.subject,
      tag: 'teams-invitation',
      model: { Team: mail.team.name, TeamSlug: mail.team.slug, Group: mail.group?.name ?? '', Role: mail.role, Token: mail.token, AcceptUrl: link, ExpiresAt: mail.expiresAt.toISOString(), Email: mail.to },
      redact: [...secrets],
      ...(options.template ? { template: options.template } : { text }),
    };
  }
}
```

- [ ] **Step 6: `src/invitations/rows.ts`**

```ts
import type { InvitationView } from '../api.js';
import { teamsDriver } from '../host.js';
import { TeamInvitation } from '../models/TeamInvitation.js';
import { dateOf } from '../views.js';

export const INVITATION_USES_TABLE = 'team_invitation_uses';

export function toInvitationView(i: TeamInvitation): InvitationView {
  return Object.freeze({
    id: i.id,
    teamId: i.team_id,
    groupId: i.group_id ?? null,
    role: i.role,
    email: i.email ?? null,
    maxUses: i.max_uses ?? null,
    uses: Number(i.uses ?? 0),
    expiresAt: dateOf(i.expires_at)!,
    revokedAt: dateOf(i.revoked_at),
    createdBy: i.created_by,
    createdAt: dateOf(i.created_at)!,
    lastSentAt: dateOf(i.last_sent_at),
  });
}

/** Invitations (and their uses) of a team or a group, before the team or group row goes. */
export async function deleteInvitations(where: { readonly team_id: string } | { readonly group_id: string }): Promise<void> {
  const ids = ((await TeamInvitation.query().where(where)) as TeamInvitation[]).map((i) => i.id);
  if (ids.length === 0) return;
  await (await teamsDriver()).del().from(INVITATION_USES_TABLE).whereIn('invitation_id', ids);
  await TeamInvitation.destroy().whereIn('id', ids);
}
```

- [ ] **Step 7: `src/invitations/service.ts`**

```ts
import { randomUUID } from 'node:crypto';

import type { AuthzCommand, Principal, PrincipalRef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, MethodNotImplemented, ResourceNotFound } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { GROUP_MEMBER_ROLE, InvitationMailer, InvitationService, VerifiedEmailSource } from '../api.js';
import type { AcceptedInvitation, CreateInvitationInput, InvitationView, Page, Paged } from '../api.js';
import { assertAllowed, domainContainer, execute } from '../host.js';
import { liveGroup, liveTeam } from '../lookup.js';
import type { Group } from '../models/Group.js';
import type { Team } from '../models/Team.js';
import { TeamInvitation } from '../models/TeamInvitation.js';
import { groupRef, teamRef } from '../refs.js';
import { TEAMS_DEFAULTS } from '../schema.js';
import { createdBy, reasonOf, undoOnFailure } from '../services/common.js';
import { readEmail, readId, readPage, readRole } from '../validate.js';
import { dateOf, toGroupView, toTeamView } from '../views.js';
import { toInvitationView } from './rows.js';
import { invitationTokenHash, newInvitationToken, readInvitationSecret } from './token.js';

const MAX_TTL_HOURS = 24 * 365;

/** Stands in for the future member in the dry run of create(): only the role and the scope are judged. */
const PROBE: PrincipalRef = Object.freeze({ type: 'user', id: '$teams-invitation-probe' });

/** What accept() runs: the role at the team, or at the group (`group.member` through the set command). */
export function acceptCommand(member: PrincipalRef, role: string, teamId: string, groupId: string | null): AuthzCommand {
  if (groupId !== null && role === GROUP_MEMBER_ROLE) return { kind: 'set.addMember', set: { role: GROUP_MEMBER_ROLE, scope: groupRef(groupId) }, member };
  return { kind: 'assignment.grant', subject: member, role, scope: groupId !== null ? groupRef(groupId) : teamRef(teamId) };
}

function readMaxUses(v: unknown, email: string | null): number | null {
  if (v === undefined) return email ? 1 : null;
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1) throw new InvalidArgument('maxUses: must be an integer of at least 1, or null', 'maxUses');
  return v as number;
}

function readHours(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_TTL_HOURS) throw new InvalidArgument(`expiresInHours: must be an integer from 1 to ${MAX_TTL_HOURS}`, 'expiresInHours');
  return v as number;
}

@Singleton()
@Injectable(InvitationService)
export class DefaultInvitationService extends InvitationService {
  @Config('teams.invitations.secret')
  protected Secret: string | undefined;

  @Config('teams.invitations.defaultTtlHours', { defaultValue: TEAMS_DEFAULTS.defaultTtlHours })
  protected DefaultTtlHours: number;

  async create(actor: Principal, input: CreateInvitationInput): Promise<{ readonly invitation: InvitationView; readonly token: string }> {
    const team = await liveTeam(input?.teamId);
    const group = input?.groupId == null ? null : await liveGroup(input.groupId);
    if (group && group.team_id !== team.id) throw new InvalidArgument('groupId: the group belongs to another team', 'groupId');
    const role = readRole(input?.role);
    const email = input?.email == null ? null : readEmail(input.email);
    const maxUses = readMaxUses(input?.maxUses, email);
    const hours = readHours(input?.expiresInHours ?? this.DefaultTtlHours);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    // Fail before anything is written: an email invitation nobody can accept is useless.
    if (email) await this.emailSource();
    // No escalation through invitations: AuthzAdmin's permission check and the guard judge the accept command as the inviter's own.
    await execute(actor, [acceptCommand(PROBE, role, team.id, group?.id ?? null)], reasonOf('invite', actor), { dryRun: true });

    const secret = readInvitationSecret(this.Secret);
    const token = newInvitationToken();
    const now = DateTime.now();
    const invitation = new TeamInvitation({ id: randomUUID(), team_id: team.id, group_id: group?.id ?? null, role, email, token_hash: invitationTokenHash(secret, token), max_uses: maxUses, uses: 0, expires_at: now.plus({ hours }), revoked_at: null, created_by: createdBy(actor), created_at: now, last_sent_at: null });
    await invitation.insert();
    if (email) {
      await undoOnFailure(
        () => this.mail(actor, invitation, team, group, token),
        () => invitation.destroy(),
      );
    }
    return Object.freeze({ invitation: toInvitationView(invitation), token });
  }

  async list(actor: Principal, teamId: string, page?: Page): Promise<Paged<InvitationView>> {
    const team = await liveTeam(teamId);
    const p = readPage(page);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const total = await TeamInvitation.query().where('team_id', team.id).selectCount();
    const rows = (await TeamInvitation.query().where('team_id', team.id).orderBy('created_at').skip(p.offset).take(p.limit)) as TeamInvitation[];
    return Object.freeze({ items: Object.freeze(rows.map(toInvitationView)), total: Number(total) });
  }

  async revoke(actor: Principal, teamId: string, id: string): Promise<void> {
    const team = await liveTeam(teamId);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const invitation = await this.invitation(team.id, id);
    if (!invitation.revoked_at) await invitation.update({ revoked_at: DateTime.now() });
  }

  async resend(actor: Principal, teamId: string, id: string): Promise<InvitationView> {
    const team = await liveTeam(teamId);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const invitation = await this.invitation(team.id, id);
    const group = invitation.group_id ? await liveGroup(invitation.group_id) : null;
    if (!invitation.email) throw new InvalidArgument('id: a link invitation has no address to mail', 'id');
    if (invitation.revoked_at || (dateOf(invitation.expires_at)?.getTime() ?? 0) <= Date.now()) throw new InvalidOperation(`invitation ${invitation.id} is revoked or expired`);
    // Only the hash is stored, so the mail carries a new token and the old one stops working.
    const secret = readInvitationSecret(this.Secret);
    const token = newInvitationToken();
    const previous = invitation.token_hash;
    await invitation.update({ token_hash: invitationTokenHash(secret, token) });
    await undoOnFailure(
      () => this.mail(actor, invitation, team, group, token),
      () => invitation.update({ token_hash: previous }),
    );
    return toInvitationView(await this.invitation(team.id, invitation.id));
  }

  async accept(_principal: Principal, _token: string): Promise<AcceptedInvitation> {
    throw new MethodNotImplemented('DefaultInvitationService.accept: lane L14 Task 10');
  }

  /** Teams ships no VerifiedEmailSource (Principal carries no verified email); the app registers one. */
  protected async emailSource(): Promise<VerifiedEmailSource> {
    const container = await domainContainer();
    if (!container.hasRegistered(VerifiedEmailSource)) {
      throw new InvalidOperation('@spinajs/teams: email invitations need a VerifiedEmailSource; register one that returns the principal\'s verified address');
    }
    return (await container.resolve(VerifiedEmailSource)) as VerifiedEmailSource;
  }

  /** Another team's invitation is reported as missing, so an id says nothing about other teams. */
  protected async invitation(teamId: string, id: unknown): Promise<TeamInvitation> {
    const key = readId(id, 'id');
    const row = await TeamInvitation.where('id', key).first();
    if (!row || row.team_id !== teamId) throw new ResourceNotFound(`invitation ${key} does not exist in team ${teamId}`);
    return row;
  }

  protected async mail(actor: Principal, invitation: TeamInvitation, team: Team, group: Group | null, token: string): Promise<void> {
    const mailer = (await DI.resolve(InvitationMailer)) as InvitationMailer;
    await mailer.send({ to: invitation.email!, team: toTeamView(team), group: group ? toGroupView(group) : null, role: invitation.role, token, expiresAt: dateOf(invitation.expires_at)!, invitedBy: { type: actor.type, id: actor.id } });
    await invitation.update({ last_sent_at: DateTime.now() });
  }
}
```

`src/invitations/index.ts`:

```ts
export * from './token.js';
export * from './mailer.js';
export * from './rows.js';
export * from './service.js';
```

`src/index.ts` gains:

```ts
export * from './invitations/index.js';
```

- [ ] **Step 8: Delete invitations with their team or group**

`DefaultTeamService.beforePurge` and `DefaultGroupService.beforeDelete` (Tasks 7-8 left them empty) now delete the invitations first, because `team_invitations` references both tables.

In `src/services/team-service.ts` add `import { deleteInvitations } from '../invitations/rows.js';` and replace `beforePurge` with:

```ts
  /** Invitations reference the team; they go first. */
  protected async beforePurge(team: Team): Promise<void> {
    await deleteInvitations({ team_id: team.id });
  }
```

In `src/services/group-service.ts` add the same import and replace `beforeDelete` with:

```ts
  /** Invitations into the group reference it; they go first. */
  protected async beforeDelete(group: Group): Promise<void> {
    await asSystem(() => deleteInvitations({ group_id: group.id }));
  }
```

- [ ] **Step 9: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/invitations/token.test.ts test/invitations/mailer.test.ts test/invitations/create.test.ts test/teams/delete.test.ts test/groups/group-service.test.ts`
Expected: PASS, `22 passing`.

- [ ] **Step 10: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): invitations with hashed tokens, mail, list, revoke and resend"
```

---

### Task 10: Accepting an invitation

**Files:**
- Modify: `packages/teams/src/invitations/service.ts` (replace the `accept` stub, add helpers)
- Test: `packages/teams/test/invitations/accept.test.ts`

**Interfaces:**
- Consumes: Task 9 (`acceptCommand`, token helpers, `INVITATION_USES_TABLE`), `VerifiedEmailSource`, `AssignmentStore.forSubjects` (authz-rbac), `execute`, `domainContainer`, `teamsDriver`.
- Produces: `InvitationService.accept(principal, token): Promise<AcceptedInvitation>`.
- Behaviour (teams §8): only an authenticated `user` principal (`not_a_user`); unknown token or a deleted team/group → `unknown`; a principal that already used the invitation gets the same answer again and nothing changes (checked before revocation and expiry, so a retry after expiry still succeeds); then `revoked`, `expired`, and for an email invitation `email_mismatch` unless the app's `VerifiedEmailSource` gives the same address (`InvalidOperation` when none is registered). The use is recorded first (insert into `team_invitation_uses` plus a compare-and-set increment of `uses` against `max_uses`, `used_up` when full, one ORM transaction); then one `SYSTEM` batch with reason `invitation:<id>` assigns the role (team), or adds the member / assigns the group role (group); a role the principal already holds at that scope is not granted twice. A failed batch removes the use again.

- [ ] **Step 1: Write the failing test**

`packages/teams/test/invitations/accept.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';

import type { Principal } from '@spinajs/authz';
import { anonymousPrincipal, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

import { GroupService, InvitationRefused, InvitationService, TeamInvitation, TeamService } from '../../src/index.js';
import type { TeamView } from '../../src/index.js';
import { groupRef, teamRef } from '../../src/refs.js';
import { failure, person, refOf, teamCreator } from '../support/people.js';
import { teamsStack } from '../support/stack.js';
import type { TeamsStack } from '../support/stack.js';

const expect = chai.expect;
const slug = (s: string) => `${s}-${randomUUID().slice(0, 8)}`;
const refusal = async (p: Promise<unknown>) => {
  const e = await failure(p);
  expect(e).to.be.instanceOf(InvitationRefused);
  return (e as InvitationRefused).code;
};

describe('InvitationService.accept', function () {
  let stack: TeamsStack;
  let teams: TeamService;
  let groups: GroupService;
  let invitations: InvitationService;

  before(async () => {
    stack = await teamsStack();
    teams = (await DI.resolve(TeamService)) as TeamService;
    groups = (await DI.resolve(GroupService)) as GroupService;
    invitations = (await DI.resolve(InvitationService)) as InvitationService;
  });

  async function ownedTeam(): Promise<{ owner: Principal; team: TeamView }> {
    const owner = await teamCreator('owner');
    return { owner, team: await teams.createTeam(owner, { slug: slug('t'), name: 'T' }) };
  }

  it('a link invitation makes each accepting user a member, once per user', async () => {
    const { owner, team } = await ownedTeam();
    const { invitation, token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const u = person('u');
    const v = person('v');
    expect(await invitations.accept(u, token)).to.deep.equal({ invitationId: invitation.id, teamId: team.id, groupId: null, role: 'team.member' });
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    await invitations.accept(u, token);
    await invitations.accept(v, token);
    expect((await invitations.list(owner, team.id)).items[0].uses).to.equal(2);
  });

  it('does not grant a role the user already holds', async () => {
    const { owner, team } = await ownedTeam();
    const u = person('u');
    await teams.addTeamMember(owner, team.id, refOf(u));
    const { token } = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    await invitations.accept(u, token);
    expect(await stack.rows('authz_assignment', { subject_type: 'user', subject_id: u.id, scope_type: 'team', scope_id: team.id })).to.have.length(1);
  });

  it('refuses used-up, revoked, expired and unknown invitations', async () => {
    const { owner, team } = await ownedTeam();
    const single = await invitations.create(owner, { teamId: team.id, role: 'team.member', maxUses: 1 });
    await invitations.accept(person('u'), single.token);
    expect(await refusal(invitations.accept(person('v'), single.token))).to.equal('used_up');

    const revoked = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    await invitations.revoke(owner, team.id, revoked.invitation.id);
    expect(await refusal(invitations.accept(person('u'), revoked.token))).to.equal('revoked');

    const expired = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    const row = (await TeamInvitation.where('id', expired.invitation.id).first())!;
    await row.update({ expires_at: DateTime.now().minus({ hours: 1 }) });
    expect(await refusal(invitations.accept(person('u'), expired.token))).to.equal('expired');

    expect(await refusal(invitations.accept(person('u'), 'no-such-token'))).to.equal('unknown');
    expect(await refusal(invitations.accept(person('u'), ''))).to.equal('unknown');
  });

  it('an email invitation needs the same verified address', async () => {
    const { owner, team } = await ownedTeam();
    const { token } = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'dana@example.com' });
    expect(await refusal(invitations.accept(person('other', { email: 'eve@example.com', emailVerified: true }), token))).to.equal('email_mismatch');
    expect(await refusal(invitations.accept(person('unverified', { email: 'dana@example.com', emailVerified: false }), token))).to.equal('email_mismatch');
    const dana = person('dana', { email: 'Dana@Example.com', emailVerified: true });
    await invitations.accept(dana, token);
    expect(await stack.authz.can(dana, 'team:read', teamRef(team.id))).to.equal(true);
  });

  it('a group invitation adds a member or grants the group role', async () => {
    const { owner, team } = await ownedTeam();
    const g = await groups.createGroup(owner, team.id, { slug: slug('g'), name: 'G' });
    const member = await invitations.create(owner, { teamId: team.id, groupId: g.id, role: 'group.member' });
    const manager = await invitations.create(owner, { teamId: team.id, groupId: g.id, role: 'group.manager' });
    const u = person('u');
    const m = person('m');
    await invitations.accept(u, member.token);
    await invitations.accept(m, manager.token);
    expect(await stack.authz.can(u, 'team:read', teamRef(team.id))).to.equal(true);
    expect(await stack.authz.can(u, 'group:members.manage', groupRef(g.id))).to.equal(false);
    expect(await stack.authz.can(m, 'group:members.manage', groupRef(g.id))).to.equal(true);
  });

  it('only a signed-in user accepts; a resent invitation drops the old token', async () => {
    const { owner, team } = await ownedTeam();
    const link = await invitations.create(owner, { teamId: team.id, role: 'team.member' });
    expect(await refusal(invitations.accept(anonymousPrincipal(), link.token))).to.equal('not_a_user');
    expect(await refusal(invitations.accept(userPrincipal(`x-${randomUUID()}`, { authenticated: false }), link.token))).to.equal('not_a_user');

    const mailed = await invitations.create(owner, { teamId: team.id, role: 'team.member', email: 'fay@example.com' });
    const before = stack.mailer.sent.length;
    await invitations.resend(owner, team.id, mailed.invitation.id);
    const fresh = stack.mailer.sent[before].token;
    const fay = person('fay', { email: 'fay@example.com', emailVerified: true });
    expect(await refusal(invitations.accept(fay, mailed.token))).to.equal('unknown');
    await invitations.accept(fay, fresh);
    expect(await stack.authz.can(fay, 'team:read', teamRef(team.id))).to.equal(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/teams && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/invitations/accept.test.ts`
Expected: FAIL, `MethodNotImplemented: DefaultInvitationService.accept: lane L14 Task 10`.

- [ ] **Step 3: Implement `accept`**

In `src/invitations/service.ts`: add `SYSTEM, principalKey` as value imports from `@spinajs/authz`; `AssignmentStore` from `@spinajs/authz-rbac`; `InvitationRefused` to the `../api.js` value import; `teamsDriver` to the `../host.js` import; `INVITATION_USES_TABLE` to the `./rows.js` import; `INVITATION_TOKEN_MAX_LENGTH, hashesEqual` to the `./token.js` import; remove `MethodNotImplemented` from the exceptions import. Replace the `accept` stub with:

```ts
  async accept(principal: Principal, token: string): Promise<AcceptedInvitation> {
    if (!principal || principal.type !== 'user' || principal.authenticated !== true) throw new InvitationRefused('not_a_user', 'only a signed-in user accepts an invitation');
    const secret = readInvitationSecret(this.Secret);
    if (typeof token !== 'string' || token === '' || token.length > INVITATION_TOKEN_MAX_LENGTH) throw new InvitationRefused('unknown');
    const hash = invitationTokenHash(secret, token);
    const invitation = await TeamInvitation.where('token_hash', hash).first();
    if (!invitation || !hashesEqual(invitation.token_hash, hash)) throw new InvitationRefused('unknown');

    const result: AcceptedInvitation = Object.freeze({ invitationId: invitation.id, teamId: invitation.team_id, groupId: invitation.group_id ?? null, role: invitation.role });
    const who = principalKey(principal);
    if (await this.usedBy(invitation.id, who)) return result;
    if (invitation.revoked_at) throw new InvitationRefused('revoked');
    if ((dateOf(invitation.expires_at)?.getTime() ?? 0) <= Date.now()) throw new InvitationRefused('expired');
    await liveTeam(invitation.team_id).catch(() => {
      throw new InvitationRefused('unknown');
    });
    if (invitation.group_id) {
      await liveGroup(invitation.group_id).catch(() => {
        throw new InvitationRefused('unknown');
      });
    }
    if (invitation.email) {
      const verified = await (await this.emailSource()).verifiedEmail(principal);
      if (typeof verified !== 'string' || verified.trim().toLowerCase() !== invitation.email) throw new InvitationRefused('email_mismatch');
    }

    await this.recordUse(invitation.id, who);
    const member: PrincipalRef = { type: principal.type, id: principal.id };
    await undoOnFailure(
      () => this.join(member, invitation),
      () => this.forgetUse(invitation.id, who),
    );
    return result;
  }
```

Add to the class:

```ts
  protected async usedBy(invitationId: string, who: string): Promise<boolean> {
    const rows = (await (await teamsDriver()).select().from(INVITATION_USES_TABLE).where({ invitation_id: invitationId, principal: who })) as unknown[];
    return rows.length > 0;
  }

  /** The use row and the counter in one transaction; the compare-and-set keeps two accepts from both taking the last use. */
  protected async recordUse(invitationId: string, who: string): Promise<void> {
    const driver = await teamsDriver();
    await driver.transaction(async () => {
      await driver.insert().into(INVITATION_USES_TABLE).values({ invitation_id: invitationId, principal: who, used_at: new Date() });
      for (let attempt = 0; attempt < 5; attempt++) {
        const [row] = (await driver.select().from('team_invitations').where('id', invitationId)) as { uses: unknown; max_uses: unknown }[];
        const uses = Number(row.uses);
        if (row.max_uses !== null && row.max_uses !== undefined && uses >= Number(row.max_uses)) throw new InvitationRefused('used_up');
        const out = (await driver.update().in('team_invitations').update({ uses: uses + 1 }).where({ id: invitationId, uses })) as { RowsAffected?: number } | undefined;
        if ((out?.RowsAffected ?? 0) > 0) return;
      }
      throw new InvalidOperation(`invitation ${invitationId} is accepted by many users at once; try again`);
    });
  }

  protected async forgetUse(invitationId: string, who: string): Promise<void> {
    const driver = await teamsDriver();
    await driver.transaction(async () => {
      await driver.del().from(INVITATION_USES_TABLE).where({ invitation_id: invitationId, principal: who });
      const [row] = (await driver.select().from('team_invitations').where('id', invitationId)) as { uses: unknown }[];
      await driver.update().in('team_invitations').update({ uses: Math.max(0, Number(row.uses) - 1) }).where('id', invitationId);
    });
  }

  /** Teams design §8: as SYSTEM, reason `invitation:<id>`; a role already held at the scope is not granted twice. */
  protected async join(member: PrincipalRef, invitation: TeamInvitation): Promise<void> {
    const scope = invitation.group_id ? groupRef(invitation.group_id) : teamRef(invitation.team_id);
    const container = await domainContainer();
    if (container.hasRegistered(AssignmentStore)) {
      const held = await ((await container.resolve(AssignmentStore)) as AssignmentStore).forSubjects([member], new Date());
      if (held.some((a) => a.role === invitation.role && a.scope.type === scope.type && a.scope.id === scope.id)) return;
    }
    await execute(SYSTEM, [acceptCommand(member, invitation.role, invitation.team_id, invitation.group_id ?? null)], `invitation:${invitation.id}`);
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams && npm run compile && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 test/invitations/accept.test.ts test/invitations/create.test.ts`
Expected: PASS, `12 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): accept invitations once per user with email match and use limits"
```

---

### Task 11: README and lane verification

**Files:**
- Modify: `packages/teams/README.md`
- Run: the whole package, the root build, the snapshot check

**Interfaces:**
- Consumes: everything above.
- Produces: package docs that L15 and apps read; a green lane.

- [ ] **Step 1: `packages/teams/README.md`**

````markdown
# @spinajs/teams

Teams, groups and invitations on authz-v3. Nothing here is app specific: teams and groups are ordinary
`@AccessResource` models, membership is `authz_assignment` rows and their closure, and every write goes through
`AuthzAdmin`.

## Model

- **Scope tree:** `team` → sub-`team` → `group` → sub-`group`, plus every resource an app declares with
  `@Parent('team')` or `@Parent('group')`. A role at a scope covers everything below it.
- **Subject tree:** a user in a nested group is a member of every outer group and of the team; a sub-team's members
  are members of the parent team (`teams.membership.subTeamsInParent`, default `true`, read when a link is written).
- **Subjects** accepted everywhere: `{ type, id }` (a principal), `{ group: id }` (`group:<id>#group.member`),
  `{ team: id }` (`team:<id>#team.member`). A whole team or group can hold any role anywhere, including on another
  team's resources (`TeamService.grant`).

## Setup

1. Depend on `@spinajs/teams`; its config fragment ships the roles (`team.member` < `team.admin` < `team.owner` on
   ladder `team`, `group.member`, `group.manager`), the permissions, the archived-team policy, the
   `authz.admin.permissions` mapping and `authz.admin.guard.keepHolders: [{ role: 'team.owner', scopeType: 'team' }]`.
   The ladder applies to every type below a team: grants you add to the team roles (e.g. `project:read` to
   `team.member`) reach your team-owned resources.
2. Run the migrations `Teams_2026_10_14_00_00_00` and `TeamsInvitations_2026_10_14_00_01_00` on the connection
   `default`, next to the authz-rbac, authz-orm and authz-abac tables (one connection: authz-orm checks it at boot).
3. Use `DbAssignmentStore` (the membership closure needs it) and `DbAuthzAdminBackend`.
4. Grant `team:create` at `$global` to whoever may create root teams (an app role).
5. For email invitations register a `VerifiedEmailSource` (teams ships none: it cannot know which of your
   principals' addresses are verified); without one they are refused with `InvalidOperation`.
6. Set `teams.invitations.secret` (≥ 32 characters, no default) and, for email invitations, `teams.invitations.url`
   (the page that accepts; the token is added as `?token=`), `teams.invitations.template` (else a plain text mail),
   `teams.invitations.subject`, `teams.invitations.connection` (else `email.defaultConnection`).
7. Archiving needs `@spinajs/authz-abac`; without an ABAC model the policy is not evaluated and archived teams stay
   writable.

## Services

`TeamService`, `GroupService`, `InvitationService` (DI tokens). Each method checks the actor first and throws
`AccessDenied`; refused admin batches throw `AuthzAdminFailure` with the guard's code (`escalation`, `last_holder`,
`set_cycle`, `forbidden`).

- People-facing writes (members, roles, transfers, grants) run as the actor, so the admin guard refuses escalation,
  removal of higher ranks and removing the last owner. Structural writes (owner on create, set links, archive,
  invitation accept) run as SYSTEM after the service's own check.
- Creating a team or group writes the authz batch first, then the row; a failed insert is undone by a second batch.
  A crash between the two leaves assignments at a scope with no row (inert, removable with `scope.forget`), never a
  team without an owner.
- `setTeamRole` replaces every role the subject holds at the team; `transferOwnership(actor, team, to, { keepAs })`
  grants the new owner first and leaves the previous owner `keepAs` (default `team.admin`, `null`: nothing).
- `grant`/`revoke` at a team or group need `team:roles.manage` there; at any other scope AuthzAdmin's permission for
  that scope type decides (`authz.admin.permissions`, default `authz:assignments.manage`).
- `teamsOf(principal)`: the principal's teams and groups with the roles held at each (directly or through a set).
- Lists (`listTeams`, `listGroups`, `members`, `InvitationService.list`) take `{ limit, offset }` (default 100, at most 500) and return `{ items, total }`; teams and groups use `.accessible('team:read')` / `.accessible('group:read').within(team)`.
- `InvitationRefused.code` (`INVITATION_REFUSALS`) is stable; map it in HTTP, not the message.

## Archive, delete, purge

- `archiveTeam` sets the scope attribute `archived`; `teams.archived.write` denies `*:create` and `*:update` on the
  team and its groups, `teams.archived.delete` denies `*:delete` on its groups. The team itself stays deletable.
  Both name their types (`scope.team.*` is indeterminate on a resource with no team ancestor): add the same
  condition for your own team-owned types to freeze them too. A sub-team is judged by its own `archived`.
  Do not mark a `*:create|update|delete` permission of those types `list: true`: ABAC cannot plan `scope.*` policies.
- `deleteTeam` is a soft delete: the team disappears from every service, its writes freeze, `restoreTeam` brings it
  back (needs `team:delete`); `purgeTeam(actor, id)` purges it at once. `purgeDue(now)` (call it from a scheduler) hard-deletes teams deleted more than
  `teams.deletion.graceDays` (default 30) ago, with their sub-teams, groups and invitations; authz-orm forgets their
  scopes; each purge publishes `TeamPurged` (`{ team, slug, teams, groups }`) to every `AuthzEventSink`.

## Invitations

`create` needs `team:invitations.manage` and is judged as the accept command run by the inviter (AuthzAdmin dry
run), so nobody invites into a role they could not grant. The token (32 random bytes, base64url) is returned once
and stored as `v1:` + HMAC-SHA256. Email invitations are mailed at once (never queued) through `InvitationMailer`
and bound to the address; `accept` compares it with the app's `VerifiedEmailSource`. `resend` mails a new token.
`accept` is idempotent per user, honours `maxUses`, expiry and revocation, and runs as SYSTEM with reason
`invitation:<id>`. New users sign up through the app's own flow and then accept with the token they kept.

## Config (`teams.*`)

| Key | Default |
|---|---|
| `membership.subTeamsInParent` | `true` |
| `deletion.graceDays` | `30` |
| `invitations.secret` | none (required for invitations) |
| `invitations.defaultTtlHours` | `168` |
| `invitations.subject` | `You are invited to join a team` |
| `invitations.template`, `invitations.url`, `invitations.connection` | none |
````

- [ ] **Step 2: Tie the README to the code**

Run (repo root):

```bash
grep -n "keepHolders\|teams.archived.write\|teams.archived.delete\|'list.assignments'" packages/teams/src/config/teams.ts
grep -n "subTeamsInParent\|graceDays\|defaultTtlHours" packages/teams/src/schema.ts
grep -rn "invitation:\${invitation.id}" packages/teams/src/invitations/service.ts
```

Expected: each grep prints at least one line.

- [ ] **Step 3: The whole package**

Run: `cd packages/teams && npm test`
Expected: every test file passes, `0 failing` (about 64 tests).

- [ ] **Step 4: Root build and snapshot**

Run (repo root):

```bash
npm run build
node scripts/api-snapshot.mjs --check
```

Expected: the build succeeds; `API snapshots are up to date` (no change to `src/api.ts` since Task 1; if a task changed it, that task's commit carries `RA14-<n>.md` and the regenerated `teams.api.md`).

- [ ] **Step 5: No leftovers**

Run: `grep -rn "MethodNotImplemented\|lane L14 Task" packages/teams/src`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/teams/README.md
git commit -m "docs(teams): package README"
```

---

## Contract issues found

Status after the coordinator's review (2026-10-14): **resolved** = decided, the plan implements the decision; **open** = depends on another lane landing as assumed.

1. **Resolved.** A set is not a `set.addMember` member (`readPrincipal`, `packages/authz-rbac/src/admin/assignments.ts`): teams links sets with `assignment.grant { subject: { set }, role, scope }` and removes them with `assignment.revokeWhere` (teams §3 corrected; L6 Task 7).
2. **Resolved.** AuthzAdmin checks the command permission for every actor, `SYSTEM` included, and runs the guard only for non-`SYSTEM` actors (`packages/authz/src/admin/admin.ts` L276, L332): the fragment maps `authz.admin.permissions` for team/group scopes; people-facing writes run as the actor (guard, `keepHolders`), structural writes as `SYSTEM` after the service's check (lane decisions 1-2).
3. **Resolved.** `AuthzService.covers` compares two principals; invitation escalation is judged by an AuthzAdmin dry run of the accept command as the inviter (lane decision 4).
4. **Resolved.** `scope.team.*` on a resource without a team ancestor is indeterminate (`compiler.ts` L360): both archived policies name their types (`team`, `group`); the README tells apps to add the condition for their own team-owned types.
5. **Resolved (documented).** ABAC refuses scoped policies for lists (overview decision 17): a `*:create|update|delete` permission of a covered type must not be `list: true` (README).
6. **Resolved.** Archiving no longer blocks deleting the team: `teams.archived.write` (`*:create`, `*:update` on team and group) and `teams.archived.delete` (`*:delete` on group only). `deleteTeam`, `restoreTeam` and `purgeTeam(actor, id)` need `team:delete`; `purgeDue` is the scheduler's system call. Tested in Tasks 5 and 8.
7. **Resolved.** `Principal` carries no verified email: `VerifiedEmailSource` is a port with no default implementation; email invitations are refused with `InvalidOperation` until the app registers one (Tasks 9, 10).
8. **Resolved (L8 Task 13).** `authz.admin.guard.keepHolders: { role, scopeType }[]` (`KeepHolder`), validated by `AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA`, refusing with `last_holder` per command before it runs (so `transferOwnership` grants first). The fragment's entry `{ role: 'team.owner', scopeType: 'team' }` matches; Task 6 asserts the code. SYSTEM skips it, as decision 1 assumes.
9. **Resolved (L4 Task 7).** `.within(ref: ResourceRef | readonly ResourceRef[]): this` on select/update/delete builders, AND-ed with `.accessible()`; `listGroups` calls `.within(teamRef(team.id))`. `.accessible()` throws `AccessDenied` on a `none` plan (L4 Task 3); teams' lists answer `{ items: [], total: 0 }`.
10. **Resolved.** The ladder `team` has no `resourceTypes` (verified: `ladders.ts` L128-132, `admin/common.ts` L82-84 apply a ladder without it everywhere); Task 5 tests a team role's grant on an app type below the team.
11. **Resolved (L8 Task 4).** Teams uses `parseSetKey(key): SetSubject | undefined` from `@spinajs/authz-rbac`; it has no parser of its own.
12. **Resolved.** `DbAuthzAdminBackend` refuses a caller transaction: `createTeam`/`createGroup` write the authz batch first and the row second, undoing the batch with a second batch when the insert fails; a crash between leaves inert assignments at a scope with no resource, never a team without an owner (lane decision 12, tested in Task 5).
13. **Resolved.** `resend` issues a new token (only its hash is stored).
14. **Resolved.** `team_invitation_uses` has a unique index on `(invitation_id, principal)` instead of a composite PK (design updated).
15. **Resolved.** `restoreTeam` added.
16. **Resolved.** `transferOwnership(actor, teamId, to, { keepAs = 'team.admin' })` (teams §7 updated): the previous owner keeps `keepAs` unless it is null or already held; tested for the default, a custom role and null.
17. **Resolved (verified in code).** A `SYSTEM` batch at a scope with no row passes: `requirePermitted` (`packages/authz/src/admin/permit.ts`) calls `check`, and the engine returns the `SYSTEM` decision at `authorizer.ts` L871-875, before the ancestors read that answers `unknown_resource` (L892-898); `resolveResource` loads nothing for a ref. Only the permission's `types` are checked before that (L864), and every mapped permission declares `team`/`group`. RBAC's `readScope` (`admin/common.ts` L281) and the scope-attribute handler's `scopeOf` (`admin/scope-attributes/handler.ts` L32) check the ref's shape only. Batch-first creation stays.
