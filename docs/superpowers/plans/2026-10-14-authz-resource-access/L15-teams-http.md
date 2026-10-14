# Lane L15: teams-http

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane. Read `docs/plans/2026-10-14-teams-design.md` (cited as *teams §n*) §7, §8 and §9, and `L14-teams.md` Task 1 (`packages/teams/src/api.ts`, the frozen surface this lane codes against).

**Goal:** A new package `@spinajs/teams-http` with the REST API of teams §9 over L14's `TeamService`, `GroupService` and `InvitationService`: every route guarded, request bodies validated by JSON schemas, service errors answered with the statuses `authz-http-admin` uses, Swagger schemas for every answer, and HTTP tests on a real SQLite stack.

**Architecture:** Seven thin controllers (one per route group) call the L14 services with the request principal as actor and answer the services' views (`TeamView`, `GroupView`, `InvitationView`, …) as JSON. The route's `@Access` checks the permission at the addressed team or group (type-level for the team list and create); the service checks again, including what the route cannot see (a parent in the body), and runs the list queries with `.accessible()` / `.within()`. `guarded()` turns `AuthzAdminFailure`, `InvitationRefused` and the `@spinajs/exceptions` errors the services throw into `{ error: { code, message, field? } }` with 400/403/404/409. Bodies are `@Schema` DTO classes (validated by http's route args, documented by http-swagger); answers are described by a `SchemaProvider`.

**Tech Stack:** TypeScript (node16 modules, ESM + CJS builds), `@spinajs/http` controllers, `@spinajs/authz-http` (`@Access`, `fromParam`, `IsAuthenticated`, `CurrentPrincipal`), `@spinajs/validation` (`@Schema`, `SchemaProvider`), `@spinajs/http-swagger`, mocha + ts-mocha + chai 4 + chai-http, SQLite in memory.

**Depends on:** L14 (`@spinajs/teams`): Task 1 needs L14 Task 1 (`api.ts`) merged; Tasks 2–8 need L14 complete (services, config fragment, migrations, `test/support/stack.ts`). Through L14: L4 Task 7 (`.within()`), L6 (set-in-set membership), L8 (`keepHolders`).

**Blocks:** nothing.

## Global Constraints

- All code, comments, docs, identifiers and commit messages in English; comments only where a reader would ask "why?" (user rule).
- Match the surrounding code: `Object.freeze` on returned values, `@Injectable(SchemaProvider)` for schema providers, controllers return `Ok` / http response classes, no `NoContent` / `Created` (no route in the repo uses them).
- New package scaffold copied from `packages/authz-abac`; added to root `tsconfig.build.json`, `tsconfig.build.cjs.json` and root `package.json` `dependencies` as `"@spinajs/teams-http": "file:packages/teams-http"`. Versions as L14: own version, `@spinajs/authz*` and `@spinajs/teams` `3.0.0-alpha.0`, other `@spinajs/*` `2.0.549`.
- Not snapshotted: `scripts/api-snapshot.json` freezes only the entry points listed under `packages` (authz-http-admin and users-http are not there either). No snapshot, no RFC.
- Every route has `@Access`, except `POST /invitations/accept` and `GET /user/teams`, which carry `@Policy(IsAuthenticated)` (Decision 2). No `@AllowAnonymous`.
- DTO classes are imported as values (`import { X }`, never `import type`): `emitDecoratorMetadata` writes the parameter type http hydrates and validates.
- Tests: mocha + chai `expect`, files `test/<name>.test.ts`, helpers in `test/support/`. All suites share one app and one in-memory database (root hooks in `test/hooks.ts`); cases stay apart by fresh ids (`uniq()`). Whole package: `cd packages/teams-http && npm test`. One file: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/<name>.test.ts` (`--no-config` drops `.mocharc.json`, so its `file` entries are given by hand; Task 1 has no `test/hooks.ts` yet: leave that `--file` out there).
- Build the dependency first: `cd packages/teams && npm run compile` after any L14 change.
- Commit after every task with a conventional message: `feat(teams-http): …`, `test(teams-http): …`, `docs(teams-http): …`.

## Decisions made in this lane

1. **Route check plus service check.** `@Access` is the route's gate (and what Swagger shows); the services stay the authority. Routes on one team or group check at that ref with `fromParam`; `GET /teams` and `POST /teams` check type-level (`team:read`, `team:create`), which passes conditionally when the caller holds the permission at any team, and the service decides the exact scope (`team:create` at the parent or `$global`). A caller who can read no team at all gets 403 from `GET /teams`; "my teams" is `GET /user/teams`.
2. **Two routes check authentication only** (`@Policy(IsAuthenticated)`, as authz-http's `/user/access/*`): `POST /invitations/accept` is authorised by the token, which `InvitationService.accept` checks (teams §8); `GET /user/teams` answers about the caller only (`TeamService.teamsOf`, teams §7: no permission). No permission names either action, and inventing one would make every app grant it to every user.
3. **One error shape.** `guarded()` answers `AuthzAdminFailure` by code with authz-http-admin's table (`src/routes/status.ts`; a unit test keeps them equal), `InvitationRefused` by code as `invitation_<code>` (`unknown` 404; `expired`, `revoked`, `used_up` 409; `email_mismatch`, `not_a_user` 403: L14 makes them all `Forbidden`, which would answer every one 403), `ResourceNotFound` → 404 `not_found`, `ResourceDuplicated` → 409 `conflict`, `InvalidArgument` → 400 `invalid_request` (with `field`). `AccessDenied` (403) and `ValidationFailed` (400, schema) keep the answers http and authz-http give them.
4. **Subjects** in paths and bodies are L14's labels (`parseSubjectLabel` / `subjectLabel`): `group:<id>` and `team:<id>` name member sets, any other `<type>:<id>` a principal (`user:<id>` in practice, teams §9); clients URL-encode path subjects. An ownership transfer takes `user:<id>` only.
5. **No document post-processor.** Unlike authz-http-admin (which reads bodies from `@Req()` on purpose), these routes take `@Body()` DTOs and `@Query(schema)` arguments, which http validates and http-swagger documents. Only the answers need a `SchemaProvider`.
6. **Answers.** Writes on a team, group or invitation answer the service's view; membership changes, deletes and revocations answer `{ ok: true }` (`TeamsOk`); lists answer `{ items, total }`. All 200, as every route in the repo. Dates are ISO 8601 strings (the views' `Date`s through JSON). The invitation token is in the create answer only, with `Cache-Control: no-store` (as authz-http-admin's link routes); the accept answer is no-store too.
7. **Every list is paged** (coordinator resolution 1: L14 gives `listTeams`, `listGroups`, `InvitationService.list` and both `members` a `Page` and a `Paged<T>` answer): query `page` (from 0, default 0) and `size` (1–200, default 50), turned into `Page { limit: size, offset: page * size }`; the answer is the service's `{ items, total }`.
8. **Invitation ids under a team path.** `InvitationService.revoke` / `resend` take the path's team id (coordinator resolution 2), so `/teams/B/invitations/<A's id>` is refused by the service; the route adds no lookup of its own.
9. **Tests share one app** (`test/hooks.ts` root hooks): the users-http harness pattern (`packages/users-http/test/support/http-app.ts`: package defaults of every installed package, SQLite `:memory:` with migrations on startup, `DbAuthzAdminBackend`) with the root registrations of L14's `test/support/stack.ts` (Task 3, Task 9): `DbScopeAttributeStore` as `ScopeAttributeStore` / `WritableScopeAttributeStore`, an `AbacModel` over the fragment's `authz.abac.policies` (the archived policies), `registerRbac`, a recording `InvitationMailer` and a `VerifiedEmailSource` (teams ships none). Instead of authn, a test principal source turns `x-user: <id>` into `user:<id>` and `x-user-email: <address>` into the verified email the email source reads (`attributes.email` with `attributes.emailVerified === true`, as L14's `AttributesEmailSource`).
10. **Restore and cross-team grants** (coordinator resolution 7): `POST /teams/:team/restore` (`team:delete`, `restoreTeam`) is added beside §9's routes. `TeamService.grant` / `revoke` (a team or group holding a role on another team's resource) get no route here: apps use authz-http-admin's `POST /authz/assignments` / `DELETE /authz/assignments/:id`, which the teams fragment's `authz.admin.permissions` mapping already authorises for team admins. `purgeTeam` / `purgeDue` stay operations for schedulers and CLIs.

## Interfaces consumed from L14 (`@spinajs/teams`)

The final `L14-teams.md` (11 tasks) plus the coordinator's resolutions, which L14 applies to `src/api.ts` with an RA14 RFC (marked *res.*). Task 8 Step 1 re-checks the merged file.

| Name | Shape |
|---|---|
| `TeamSubject` | `PrincipalRef \| { group: string } \| { team: string }` |
| `subjectLabel(s)`, `parseSubjectLabel(label)` | `src/subjects.ts`, exported from the root: `group:<id>` / `team:<id>` are sets, any other `<type>:<id>` a principal; a bad label throws `InvalidArgument('subject must be <type>:<id>', 'subject')` |
| `TeamView` | `{ id; parentId: string \| null; slug; name; description: string \| null; archivedAt: Date \| null; deletedAt: Date \| null; createdBy: string \| null; createdAt: Date; updatedAt: Date }` |
| `GroupView` | `{ id; teamId; parentId: string \| null; slug; name; description: string \| null; createdBy: string \| null; createdAt: Date; updatedAt: Date }` |
| `InvitationView` | `{ id; teamId; groupId: string \| null; role; email: string \| null; maxUses: number \| null; uses: number; expiresAt: Date; revokedAt: Date \| null; createdBy: string; createdAt: Date; lastSentAt: Date \| null }` |
| `MemberEntry` | `{ subject: TeamSubject; role; assignmentId; expiresAt: Date \| null }` |
| `Page`, `Paged<T>` | `{ limit; offset }`, `{ items: readonly T[]; total }` |
| `PrincipalTeams` | `{ teams: (TeamView & { roles })[]; groups: (GroupView & { roles })[] }` |
| inputs | `CreateTeamInput { slug; name; description?; parentId?; owner? }`, `UpdateTeamInput { slug?; name?; description? }`, `CreateGroupInput { slug; name; description?; parentId? }`, `UpdateGroupInput = UpdateTeamInput`, `MoveGroupInput { teamId?; parentId: string \| null }`, `CreateInvitationInput { teamId; groupId?; role; email?; maxUses?; expiresInHours? }`, `AcceptedInvitation { invitationId; teamId; groupId: string \| null; role }`, `InvitationMail { to; team; group; role; token; expiresAt; invitedBy }` |
| `TeamService` | `createTeam(actor, input)`, `getTeam(actor, id)`, *res.* `listTeams(actor, opts?: { parentId?: string \| null; page?: Page }): Paged<TeamView>`, `updateTeam(actor, id, input)`, `moveTeam(actor, id, parentId)`, `archiveTeam(actor, id)`, `unarchiveTeam(actor, id)`, `deleteTeam(actor, id): void` (refuses a team with live sub-teams), `restoreTeam(actor, id): TeamView` (`team:delete`), `members(actor, teamId, page?): Paged<MemberEntry>`, `addTeamMember(actor, teamId, subject, role?)`, `removeTeamMember(actor, teamId, subject)`, `setTeamRole(actor, teamId, subject, role)`, `transferOwnership(actor, teamId, to: PrincipalRef, opts?: { keepAs?: string \| null })` (the old owner keeps `keepAs`, default `team.admin`; `null`: nothing), `teamsOf(principal): PrincipalTeams`; no route: `grant`, `revoke`, `purgeTeam(actor, id)`, `purgeDue(now?)` |
| `GroupService` | `createGroup(actor, teamId, input)`, `getGroup(actor, id)`, *res.* `listGroups(actor, teamId, page?: Page): Paged<GroupView>`, `updateGroup(actor, id, input)`, `moveGroup(actor, id, to)`, `deleteGroup(actor, id): void` (hard delete; refuses a group with sub-groups), `members(actor, groupId, page?): Paged<MemberEntry>`, `addGroupMember(actor, groupId, subject)`, `removeGroupMember(actor, groupId, subject)` |
| `InvitationService` | `create(actor, input): { invitation; token }`, *res.* `list(actor, teamId, page?: Page): Paged<InvitationView>`, *res.* `revoke(actor, teamId, id): void`, *res.* `resend(actor, teamId, id): InvitationView` (rotates the token), `accept(principal, token): AcceptedInvitation` |
| `InvitationMailer`, `VerifiedEmailSource` | `send(mail: InvitationMail)`; `verifiedEmail(principal): Promise<string \| undefined>`. Teams ships no `VerifiedEmailSource`: without one, email invitations fail with `InvalidOperation` |
| `InvitationRefused` | `extends Forbidden`, stable `code: 'unknown' \| 'revoked' \| 'expired' \| 'used_up' \| 'email_mismatch' \| 'not_a_user'`, default message `invitation refused: <code>` |
| Errors (L14 Global Constraints) | bad input `InvalidArgument(message, field)`, unknown or deleted rows `ResourceNotFound`, duplicate slugs `ResourceDuplicated`, refused checks `AccessDenied`, refused admin batches `AuthzAdminFailure(code, message, field)` (the first failed result, rethrown), invitation refusals `InvitationRefused(code)` |
| Fragment (L14 Task 3) | roles, permissions (`group:create` declares `team` among its types, *res.*), the `authz.admin.permissions` mapping for team and group scopes, `keepHolders`, the archived policies under `authz.abac.policies` (`teams.archived.write` denies `*:create` / `*:update` on teams and groups); an app adds a role holding `team:create` at `$global` |
| Defaults | email invitation `maxUses` 1, link unlimited; `expiresInHours` default `teams.invitations.defaultTtlHours` (168); groups hard-deleted, teams soft-deleted |

## Files

| File | Task |
|---|---|
| `packages/teams-http/{.eslintignore,.eslintrc.cjs,.gitignore,.npmignore,.prettierrc,typedoc.json}` (copied) | 1 |
| `packages/teams-http/{package.json,tsconfig.json,tsconfig.mjs.json,tsconfig.cjs.json,.mocharc.json}` | 1 (`.mocharc.json` again in 2) |
| `packages/teams-http/src/index.ts` | 1, 2–7 (export lines) |
| `packages/teams-http/src/config/teams-http.ts` | 1 |
| `packages/teams-http/src/controller-list.ts` | 1, 2–6 |
| `packages/teams-http/src/http/errors.ts`, `src/http/answers.ts`, `src/http/subjects.ts`, `src/http/request.ts` | 1 |
| `packages/teams-http/src/http/refs.ts`, `src/schemas/bodies.ts` | 2 (bodies grow in 3–5) |
| `packages/teams-http/src/controllers/TeamsController.ts` | 2 |
| `packages/teams-http/src/controllers/TeamMembersController.ts` | 3 |
| `packages/teams-http/src/controllers/TeamGroupsController.ts`, `GroupsController.ts` | 4 |
| `packages/teams-http/src/controllers/TeamInvitationsController.ts`, `InvitationsController.ts` | 5 |
| `packages/teams-http/src/controllers/UserTeamsController.ts` | 6 |
| `packages/teams-http/src/schemas/responses.ts`, `provider.ts`, `index.ts` | 7 |
| `packages/teams-http/README.md` | 8 |
| `packages/teams-http/test/setup.ts`, `test/helpers.test.ts` | 1 |
| `packages/teams-http/test/hooks.ts`, `test/support/app.ts`, `test/support/client.ts`, `test/teams.test.ts` | 2 |
| `packages/teams-http/test/members.test.ts` | 3 |
| `packages/teams-http/test/groups.test.ts` | 4 |
| `packages/teams-http/test/invitations.test.ts` | 5 |
| `packages/teams-http/test/user-teams.test.ts`, `test/routes.test.ts` | 6 |
| `packages/teams-http/test/swagger.test.ts` | 7 |
| root `tsconfig.build.json`, `tsconfig.build.cjs.json`, `package.json` | 1 |

---

### Task 1: Scaffold, error mapping and request helpers

**Files:**
- Create: the scaffold (above), `src/index.ts`, `src/config/teams-http.ts`, `src/controller-list.ts`, `src/http/errors.ts`, `src/http/answers.ts`, `src/http/subjects.ts`, `src/http/request.ts`, `test/setup.ts`, `test/helpers.test.ts`
- Modify: root `tsconfig.build.json`, `tsconfig.build.cjs.json`, `package.json`

**Interfaces:**
- Consumes: `AuthzAdminFailure`, `PrincipalRef` (`@spinajs/authz`); `InvitationRefused`, `subjectLabel`, `MemberEntry`, `Page`, `Paged` (L14); `InvalidArgument`, `ResourceNotFound`, `ResourceDuplicated` (`@spinajs/exceptions`); `adminErrorStatus(code)` (`packages/authz-http-admin/src/routes/status.ts`, test only).
- Produces:
  - `src/http/errors.ts`: `teamsErrorStatus(code: string): 400 | 403 | 404 | 409`; `interface TeamsHttpError { code; message; field? }`; `teamsFailureAnswer(e: unknown): { status: number; error: TeamsHttpError } | undefined`; `respond(status: number, body: unknown): Response`; `guarded(fn: () => Promise<Response>): Promise<Response>`.
  - `src/http/answers.ts`: `NO_STORE: IResponseHeader`; `done(): Response` (`{ ok: true }`); `interface MemberJson { subject: string; role: string; assignmentId: string; expiresAt: Date | null }`; `memberJson(m: MemberEntry): MemberJson`; `membersJson(p: Paged<MemberEntry>): { items: readonly MemberJson[]; total: number }`.
  - `src/http/subjects.ts`: `SUBJECT_PATTERN` (the body schema's pattern of a label); `parseUser(text: unknown, field: string): PrincipalRef`. Other subjects go through L14's `parseSubjectLabel`.
  - `src/http/request.ts`: `DEFAULT_PAGE_SIZE = 50`, `MAX_PAGE_SIZE = 200`; `pageOf(page?: number, size?: number): Page`; `pageQuery()`, `sizeQuery()` (fresh JSON schemas for `@Query`); `definedOnly<T extends object>(o: T): T`.
  - `TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[]` (empty here, grown by Tasks 2–6).

- [ ] **Step 1: Copy the scaffold and write the package files**

Run (repo root, bash):

```bash
mkdir -p packages/teams-http/src/config packages/teams-http/src/controllers packages/teams-http/src/http packages/teams-http/src/schemas packages/teams-http/test/support
for f in .eslintignore .eslintrc.cjs .gitignore .npmignore .prettierrc typedoc.json; do cp packages/authz-abac/$f packages/teams-http/$f; done
```

Create `packages/teams-http/package.json`:

```json
{
  "name": "@spinajs/teams-http",
  "version": "3.0.0-alpha.0",
  "description": "REST API over SpinaJS teams, groups and invitations",
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
    "test": "ts-mocha -p tsconfig.json test/**/*.test.ts",
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
    "teams",
    "authz"
  ],
  "author": "SpinaJS <spinajs@coderush.pl> (https://github.com/spinajs/main)",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/spinajs/main/issues"
  },
  "homepage": "https://github.com/spinajs/main#readme",
  "dependencies": {
    "@spinajs/authz": "3.0.0-alpha.0",
    "@spinajs/authz-http": "3.0.0-alpha.0",
    "@spinajs/configuration": "2.0.549",
    "@spinajs/di": "2.0.549",
    "@spinajs/exceptions": "2.0.549",
    "@spinajs/http": "2.0.549",
    "@spinajs/teams": "3.0.0-alpha.0",
    "@spinajs/validation": "2.0.549"
  },
  "devDependencies": {
    "@spinajs/authz-abac": "3.0.0-alpha.0",
    "@spinajs/authz-orm": "3.0.0-alpha.0",
    "@spinajs/authz-rbac": "3.0.0-alpha.0",
    "@spinajs/authz-testing": "3.0.0-alpha.0",
    "@spinajs/fs": "2.0.549",
    "@spinajs/http-swagger": "2.0.549",
    "@spinajs/log": "2.0.549",
    "@spinajs/orm": "2.0.549",
    "@spinajs/orm-sqlite": "2.0.549"
  }
}
```

Create `packages/teams-http/tsconfig.json`:

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
  "references": [{ "path": "../authz/tsconfig.json" }, { "path": "../authz-http/tsconfig.json" }, { "path": "../teams/tsconfig.json" }, { "path": "../configuration/tsconfig.json" }, { "path": "../di/tsconfig.json" }, { "path": "../exceptions/tsconfig.json" }, { "path": "../http/tsconfig.json" }, { "path": "../validation/tsconfig.json" }, { "path": "../log/tsconfig.json" }, { "path": "../authz-abac/tsconfig.json" }, { "path": "../authz-orm/tsconfig.json" }, { "path": "../authz-rbac/tsconfig.json" }, { "path": "../authz-testing/tsconfig.json" }, { "path": "../orm/tsconfig.json" }, { "path": "../orm-sqlite/tsconfig.json" }, { "path": "../fs/tsconfig.json" }, { "path": "../http-swagger/tsconfig.json" }]
}
```

Create `packages/teams-http/tsconfig.mjs.json`:

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
  "references": [{ "path": "../authz/tsconfig.mjs.json" }, { "path": "../authz-http/tsconfig.mjs.json" }, { "path": "../teams/tsconfig.mjs.json" }, { "path": "../configuration/tsconfig.mjs.json" }, { "path": "../di/tsconfig.mjs.json" }, { "path": "../exceptions/tsconfig.mjs.json" }, { "path": "../http/tsconfig.mjs.json" }, { "path": "../validation/tsconfig.mjs.json" }]
}
```

Create `packages/teams-http/tsconfig.cjs.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib/cjs",
    "module": "commonjs"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../authz/tsconfig.cjs.json" }, { "path": "../authz-http/tsconfig.cjs.json" }, { "path": "../teams/tsconfig.cjs.json" }, { "path": "../configuration/tsconfig.cjs.json" }, { "path": "../di/tsconfig.cjs.json" }, { "path": "../exceptions/tsconfig.cjs.json" }, { "path": "../http/tsconfig.cjs.json" }, { "path": "../validation/tsconfig.cjs.json" }]
}
```

Create `packages/teams-http/.mocharc.json` (Task 2 adds `test/hooks.ts` to `file`):

```json
{
  "extensions": [
    "ts"
  ],
  "spec": [
    "test/**/*.test.ts"
  ],
  "file": [
    "test/setup.ts"
  ],
  "timeout": 60000,
  "node-option": [
    "experimental-specifier-resolution=node",
    "loader=ts-node/esm"
  ]
}
```

Create `packages/teams-http/test/setup.ts`:

```ts
import { DI } from '@spinajs/di';

// Config sources pick lib/mjs or lib/cjs on their first resolve; a lib/cjs config file loads a
// second, CommonJS copy of @spinajs/di, whose Array.ofType resolves nothing (see http's test/setup.ts).
DI.setESMModuleSupport();
```

Create `packages/teams-http/src/config/teams-http.ts`:

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'teams-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const teamsHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
};

export default teamsHttp;
```

Create `packages/teams-http/src/controller-list.ts`:

```ts
import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([]);
```

In root `tsconfig.build.json`, after `{ "path": "packages/teams/tsconfig.mjs.json" },` (L14 Task 1) add:

```json
    { "path": "packages/teams-http/tsconfig.mjs.json" },
```

In root `tsconfig.build.cjs.json`, after `{ "path": "./packages/teams/tsconfig.cjs.json" },` add:

```json
    { "path": "./packages/teams-http/tsconfig.cjs.json" },
```

In root `package.json` `dependencies`, after `"@spinajs/teams": "file:packages/teams",` add:

```json
    "@spinajs/teams-http": "file:packages/teams-http",
```

Run: `npm install --no-audit --no-fund 2>&1 | tail -1` (repo root)
Expected: a summary line without `ERR!`; `ls -la node_modules/@spinajs/teams-http` shows a link to `packages/teams-http`.

- [ ] **Step 2: Write the failing helper tests**

Create `packages/teams-http/test/helpers.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { AccessDenied, AuthzAdminFailure, FALSE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { InvitationRefused } from '@spinajs/teams';

// authz-http-admin's answer table; a relative import, as authz-http-admin's tests reach authz-rbac's.
import { adminErrorStatus } from '../../authz-http-admin/src/routes/status.js';
import { memberJson } from '../src/http/answers.js';
import { teamsErrorStatus, teamsFailureAnswer } from '../src/http/errors.js';
import { DEFAULT_PAGE_SIZE, definedOnly, pageOf } from '../src/http/request.js';
import { SUBJECT_PATTERN, parseUser } from '../src/http/subjects.js';

const ADMIN_CODES = ['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role', 'not_found', 'conflict', 'unknown_role', 'not_assignable', 'wrong_scope_type', 'unknown_ladder', 'unknown_permission', 'invalid_attributes', 'not_list_filterable', 'set_cycle', 'set_too_deep', 'invalid_request', 'invalid_batch'];

describe('teams-http helpers', () => {
  describe('teamsErrorStatus', () => {
    it('answers every AuthzAdmin code as authz-http-admin does', () => {
      for (const code of ADMIN_CODES) expect(teamsErrorStatus(code), code).to.eq(adminErrorStatus(code));
    });

    it('answers the invitation codes', () => {
      expect(teamsErrorStatus('invitation_unknown')).to.eq(404);
      for (const code of ['invitation_expired', 'invitation_revoked', 'invitation_used_up']) expect(teamsErrorStatus(code), code).to.eq(409);
      for (const code of ['invitation_email_mismatch', 'invitation_not_a_user']) expect(teamsErrorStatus(code), code).to.eq(403);
      expect(teamsErrorStatus('no_such_code')).to.eq(400);
    });
  });

  describe('teamsFailureAnswer', () => {
    it('answers AuthzAdminFailure by code with the field, and InvitationRefused as invitation_<code>', () => {
      expect(teamsFailureAnswer(new AuthzAdminFailure('last_holder', 'team:t1 keeps one team.owner', 'subject'))).to.deep.eq({ status: 403, error: { code: 'last_holder', message: 'team:t1 keeps one team.owner', field: 'subject' } });
      expect(teamsFailureAnswer(new InvitationRefused('used_up'))).to.deep.eq({ status: 409, error: { code: 'invitation_used_up', message: 'invitation refused: used_up' } });
      expect(teamsFailureAnswer(new InvitationRefused('unknown'))?.status).to.eq(404);
      expect(teamsFailureAnswer(new InvitationRefused('email_mismatch'))?.status).to.eq(403);
    });

    it('answers the @spinajs/exceptions errors the services throw', () => {
      expect(teamsFailureAnswer(new ResourceNotFound('team t1 not found'))).to.deep.eq({ status: 404, error: { code: 'not_found', message: 'team t1 not found' } });
      expect(teamsFailureAnswer(new ResourceDuplicated('slug red is taken'))).to.deep.eq({ status: 409, error: { code: 'conflict', message: 'slug red is taken' } });
      expect(teamsFailureAnswer(new InvalidArgument('the parent group is in another team', 'parentId'))).to.deep.eq({ status: 400, error: { code: 'invalid_request', message: 'the parent group is in another team', field: 'parentId' } });
    });

    it('leaves AccessDenied and unknown errors to http', () => {
      const decision = { permission: 'team:read', resource: { type: 'team', id: 't1' }, allowed: false, residual: FALSE, reason: { code: 'no_grant' } } as unknown as Decision;
      expect(teamsFailureAnswer(new AccessDenied(decision))).to.eq(undefined);
      expect(teamsFailureAnswer(new Error('boom'))).to.eq(undefined);
      expect(teamsFailureAnswer(Object.assign(new Error('db'), { code: 'SQLITE_CONSTRAINT' }))).to.eq(undefined);
    });
  });

  describe('subjects', () => {
    it('reads a user for an ownership transfer and refuses a set', () => {
      expect(parseUser('user:42', 'to')).to.deep.eq({ type: 'user', id: '42' });
      for (const bad of ['group:g1', 'user:', 'alice', 42]) expect(() => parseUser(bad, 'to'), String(bad)).to.throw(InvalidArgument, /user:<id>/).with.property('fieldName', 'to');
    });

    it('lets the body schema pass every label parseSubjectLabel reads', () => {
      const pattern = new RegExp(SUBJECT_PATTERN);
      for (const ok of ['user:42', 'group:g1', 'team:t:1', 'service:s1']) expect(pattern.test(ok), ok).to.eq(true);
      for (const bad of ['alice', 'user:', ':42']) expect(pattern.test(bad), bad).to.eq(false);
    });
  });

  describe('request and answer helpers', () => {
    it('turns page and size into a Page', () => {
      expect(pageOf()).to.deep.eq({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
      expect(pageOf(2, 10)).to.deep.eq({ limit: 10, offset: 20 });
      expect(pageOf(3)).to.deep.eq({ limit: DEFAULT_PAGE_SIZE, offset: 3 * DEFAULT_PAGE_SIZE });
      expect(Object.isFrozen(pageOf())).to.eq(true);
    });

    it('drops undefined keys and keeps null', () => {
      expect(definedOnly({ a: 1, b: undefined, c: null })).to.deep.eq({ a: 1, c: null });
      expect(Object.keys(definedOnly({ a: undefined }))).to.deep.eq([]);
    });

    it('answers a member with its subject as a label', () => {
      expect(memberJson({ subject: { group: 'g1' }, role: 'team.member', assignmentId: 'a1', expiresAt: null })).to.deep.eq({ subject: 'group:g1', role: 'team.member', assignmentId: 'a1', expiresAt: null });
      expect(memberJson({ subject: { type: 'user', id: '42' }, role: 'team.owner', assignmentId: 'a2', expiresAt: null }).subject).to.eq('user:42');
    });
  });
});
```

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts test/helpers.test.ts`
Expected: FAIL, `Cannot find module '…/src/http/answers.js'`.

- [ ] **Step 3: Write the helpers**

Create `packages/teams-http/src/http/errors.ts`:

```ts
import { AuthzAdminFailure } from '@spinajs/authz';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { BadRequestResponse, Conflict, ForbiddenResponse, NotFound } from '@spinajs/http';
import type { Response } from '@spinajs/http';
import { InvitationRefused } from '@spinajs/teams';

export interface TeamsHttpError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

// The AuthzAdmin codes answer as on authz-http-admin's routes; test/helpers.test.ts compares the two tables.
const REFUSED = new Set(['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role', 'invitation_email_mismatch', 'invitation_not_a_user']);
const MISSING = new Set(['not_found', 'invitation_unknown']);
const CONFLICTING = new Set(['conflict', 'invitation_expired', 'invitation_revoked', 'invitation_used_up']);

/** 403 for a refusal, 404 for a missing row, 409 for a state that refuses the request, 400 for the rest (validation). */
export function teamsErrorStatus(code: string): 400 | 403 | 404 | 409 {
  if (REFUSED.has(code)) return 403;
  if (MISSING.has(code)) return 404;
  if (CONFLICTING.has(code)) return 409;
  return 400;
}

function answer(status: number, code: string, message: string, field?: string): { readonly status: number; readonly error: TeamsHttpError } {
  return Object.freeze({ status, error: Object.freeze({ code, message, ...(field === undefined || field === null ? {} : { field }) }) });
}

/**
 * The answer to an error a teams service throws. Undefined for what http and authz-http answer
 * themselves (AccessDenied 403, ValidationFailed 400) and for anything else, which stays a 500:
 * a driver error carries a `code` too and must not be read as a refusal.
 */
export function teamsFailureAnswer(e: unknown): { readonly status: number; readonly error: TeamsHttpError } | undefined {
  if (e instanceof AuthzAdminFailure) return answer(teamsErrorStatus(e.code), e.code, e.message, e.field);
  // InvitationRefused is a Forbidden for every code; a client needs 404 for an unknown token and 409 for a spent one.
  if (e instanceof InvitationRefused) {
    const code = `invitation_${e.code}`;
    return answer(teamsErrorStatus(code), code, e.message);
  }
  if (e instanceof ResourceNotFound) return answer(404, 'not_found', e.message);
  if (e instanceof ResourceDuplicated) return answer(409, 'conflict', e.message);
  if (e instanceof InvalidArgument) return answer(400, 'invalid_request', e.message, e.fieldName);
  return undefined;
}

export function respond(status: number, body: unknown): Response {
  switch (status) {
    case 403:
      return new ForbiddenResponse(body);
    case 404:
      return new NotFound(body);
    case 409:
      return new Conflict(body);
    default:
      return new BadRequestResponse(body);
  }
}

/** Runs a route; a service error with a known answer becomes `{ error: { code, message, field? } }` with its status. */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const known = teamsFailureAnswer(e);
    if (!known) throw e;
    return respond(known.status, { error: known.error });
  }
}
```

Create `packages/teams-http/src/http/subjects.ts`:

```ts
import type { PrincipalRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

/** A subject label as L14's parseSubjectLabel reads it: `<type>:<id>`, the id everything after the first `:`. */
export const SUBJECT_PATTERN = '^[^:]+:.+$';

/** A user only: ownership goes to a person, never to a set. */
export function parseUser(text: unknown, field: string): PrincipalRef {
  if (typeof text === 'string' && text.startsWith('user:') && text.length > 'user:'.length) return Object.freeze({ type: 'user', id: text.slice('user:'.length) });
  throw new InvalidArgument(`${field} must be user:<id>`, field);
}
```

Create `packages/teams-http/src/http/request.ts`:

```ts
import type { Page } from '@spinajs/teams';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Fresh objects: http-swagger rewrites the schema nodes it walks.
export const pageQuery = () => ({ type: 'integer', minimum: 0, description: 'page number from 0 (default 0)' });
export const sizeQuery = () => ({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, description: `page size (default ${DEFAULT_PAGE_SIZE})` });

/** `@Query` validated `page` and `size` against the schemas above; absent ones take the defaults. */
export function pageOf(page?: number, size?: number): Page {
  const limit = size ?? DEFAULT_PAGE_SIZE;
  return Object.freeze({ limit, offset: (page ?? 0) * limit });
}

/** A copy without the undefined keys, so a service reading `'key' in input` sees only what the client sent. */
export function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
```

Create `packages/teams-http/src/http/answers.ts`:

```ts
import { Ok } from '@spinajs/http';
import type { IResponseHeader, Response } from '@spinajs/http';
import { subjectLabel } from '@spinajs/teams';
import type { MemberEntry, Paged } from '@spinajs/teams';

export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

export function done(): Response {
  return new Ok({ ok: true });
}

export interface MemberJson {
  readonly subject: string;
  readonly role: string;
  readonly assignmentId: string;
  readonly expiresAt: Date | null;
}

export function memberJson(m: MemberEntry): MemberJson {
  return Object.freeze({ subject: subjectLabel(m.subject), role: m.role, assignmentId: m.assignmentId, expiresAt: m.expiresAt });
}

export function membersJson(page: Paged<MemberEntry>): { readonly items: readonly MemberJson[]; readonly total: number } {
  return Object.freeze({ items: Object.freeze(page.items.map(memberJson)), total: page.total });
}
```

Create `packages/teams-http/src/index.ts`:

```ts
export * from './http/answers.js';
export * from './http/errors.js';
export * from './http/request.js';
export * from './http/subjects.js';
export * from './controller-list.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams && npm run compile && cd ../teams-http && npm test`
Expected: `tsc -b tsconfig.mjs.json` without errors, then `10 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/teams-http tsconfig.build.json tsconfig.build.cjs.json package.json package-lock.json
git commit -m "feat(teams-http): package scaffold, error mapping and request helpers"
```

---

### Task 2: Test harness and the teams routes

**Files:**
- Create: `test/hooks.ts`, `test/support/app.ts`, `test/support/client.ts`, `src/http/refs.ts`, `src/schemas/bodies.ts`, `src/controllers/TeamsController.ts`, `test/teams.test.ts`
- Modify: `.mocharc.json` (`file`), `src/controller-list.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Task 1; L14 `TeamService` (`listTeams`, `getTeam`, `createTeam`, `updateTeam`, `moveTeam`, `archiveTeam`, `unarchiveTeam`, `deleteTeam`, `restoreTeam`, `transferOwnership`), `InvitationMailer`, `InvitationMail`, `VerifiedEmailSource`; authz `ScopeAttributeStore`, `WritableScopeAttributeStore`, `AuthorizationModel`, `AuthzContributor`; authz-abac `AbacModel`, `AbacContributor`, `ConfigPolicyStore`; authz-orm `DbScopeAttributeStore`; authz-http `Access`, `CurrentPrincipal`, `fromParam`, `PrincipalSource`; authz-rbac `registerRbac`; authz-testing `testHost`, `userPrincipal`.
- Produces: `TEAM` / `GROUP` extractors (`src/http/refs.ts`); body schema parts `slugSchema()`, `nameSchema()`, `descriptionSchema()`, `idSchema()`, `nullableIdSchema()`, `subjectSchema()`, `object(required, properties, extra?)`; DTOs `CreateTeamBody`, `UpdateTeamBody`, `MoveTeamBody`, `TransferTeamBody`; `TeamsController`. Test support: `startTeamsApp(): Promise<number>`, `stopTeamsApp()`, `appPort()`, `USER_HEADER = 'x-user'`, `EMAIL_HEADER = 'x-user-email'`, `RecordingInvitationMailer` (static `sent: InvitationMail[]`); `send(method, path, { as?, email?, body? }): Promise<Res>`, `as(user, email?): Client` (`get`, `post`, `patch`, `del`), `uniq(prefix)`, `teamRef(id)`, `groupRef(id)`, `subjectPath(user)`, `grantAt(user, role, scope)`, `platformUser()`, `createTeam(owner, body?)`, `ownedTeam()`.

- [ ] **Step 1: The app the suites share**

The root registrations below are those of L14's `packages/teams/test/support/stack.ts` (`boot()`, Task 3 Step 4 and Task 9), in its order: scope attribute store, ABAC model over the fragment's policies, `registerRbac`; mailer and email source. Its event sink is left out (nothing here reads events).

Create `packages/teams-http/test/support/app.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthorizationModel, AuthzContributor, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AbacContributor, AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { PrincipalSource } from '@spinajs/authz-http';
// Importing authz-orm also registers the list helpers and the ancestor table maintenance (QueryMiddleware).
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { registerRbac } from '@spinajs/authz-rbac';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { InvitationMailer, VerifiedEmailSource } from '@spinajs/teams';
import type { InvitationMail } from '@spinajs/teams';

import { TEAMS_HTTP_CONTROLLERS } from '../../src/controller-list.js';

chai.use(chaiHttp);

export const USER_HEADER = 'x-user';
export const EMAIL_HEADER = 'x-user-email';

const INVITATION_SECRET = 'teams-http-test-invitation-secret-0123456789abcdef';
const LINK_SECRET = 'teams-http-test-link-secret-0123456789abcdef';

/**
 * `x-user: <id>` is the authenticated `user:<id>`; `x-user-email` gives it a verified email in the
 * attributes L14's default VerifiedEmailSource reads. Without `x-user` this source yields nothing.
 */
class HeaderPrincipalSource extends PrincipalSource {
  public readonly name = 'teams-http-test';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers[USER_HEADER];
    if (typeof id !== 'string' || id.length === 0) return null;
    const email = req.headers[EMAIL_HEADER];
    return userPrincipal(id, typeof email === 'string' && email.length > 0 ? { attributes: { email, emailVerified: true } } : {});
  }
}

/** Keeps invitation mail off the wire; the cases read the mails, tokens included. */
export class RecordingInvitationMailer extends InvitationMailer {
  public static readonly sent: InvitationMail[] = [];

  public async send(mail: InvitationMail): Promise<void> {
    RecordingInvitationMailer.sent.push(mail);
  }
}

/** What an app registers (teams ships none); the same rule as L14's test AttributesEmailSource. */
class AttributesEmailSource extends VerifiedEmailSource {
  public async verifiedEmail(principal: Principal): Promise<string | undefined> {
    const a = principal.attributes ?? {};
    return a.emailVerified === true && typeof a.email === 'string' ? a.email : undefined;
  }
}

/**
 * The package defaults of every installed @spinajs package, as an app loads them, with this test's
 * database and secrets. `test.platform` at $global is how a case gets a user who may create root teams.
 */
class TeamsHttpTestConfiguration extends FrameworkConfiguration {
  public async load(): Promise<void> {
    await super.load();
    // Set after the defaults merged: they list the controller dirs of every installed package.
    this.set(['system', 'dirs', 'controllers'], []);
    this.set(['http', 'port'], 0);
    const providers = (this.get<{ name?: string }[]>(['fs', 'providers']) ?? []).filter((p) => p.name !== '__fs_controller_cache__');
    this.set(['fs', 'providers'], [...providers, { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-teams-http-test-cache') }]);
  }

  protected onLoad(): unknown {
    return {
      // The env authz-orm's runtime guard reads: 'test' makes an unscoped multi-row select throw.
      env: 'test',
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authz: {
        // AuthzAdmin checks it for the SYSTEM seeds at $global; the teams fragment maps only team and group scopes.
        permissions: { 'authz:assignments.manage': {} },
        admin: {
          backend: 'DbAuthzAdminBackend',
          connection: 'default',
          guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
        },
        rbac: {
          connection: 'default',
          stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
          links: { secret: LINK_SECRET },
          roles: { 'test.platform': { grants: ['team:create'], scopeTypes: ['$global'] } },
        },
      },
      teams: { invitations: { secret: INVITATION_SECRET } },
      queue: { default: 'teams-http-test-queue', connections: [{ service: 'BlackHoleQueueClient', name: 'teams-http-test-queue' }] },
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

let running: { readonly server: HttpServer; readonly port: number } | undefined;

/**
 * Boots one http server for the whole run: real root authz (RBAC with config roles, assignments in
 * SQLite, DbAuthzAdminBackend, authz-orm list helpers), L14's services, fragment and migrations,
 * every teams-http controller, and the `x-user` principal source. Started and stopped by test/hooks.ts.
 */
export async function startTeamsApp(): Promise<number> {
  if (running) return running.port;

  DI.register(TeamsHttpTestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  DI.register(HeaderPrincipalSource).as(PrincipalSource);
  DI.register(RecordingInvitationMailer).as(InvitationMailer);
  DI.register(AttributesEmailSource).as(VerifiedEmailSource);

  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
    await b.bootstrap();
  }
  const config = (await DI.resolve(Configuration)) as Configuration;
  // Before anything resolves the root AuthzService, whose boot reads the models and stores registered here.
  const root = DI.RootContainer;
  const attributes = new DbScopeAttributeStore({ container: root });
  root.register(testHost.instance(attributes)).as(ScopeAttributeStore);
  root.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
  const abac = new AbacModel({ stores: [new ConfigPolicyStore(config.get<unknown[]>(['authz', 'abac', 'policies'], []))] });
  root.register(testHost.instance(abac)).as(AuthorizationModel);
  root.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
  await registerRbac(root, config);
  await DI.resolve(fsService);
  await DI.resolve(Orm);

  for (const c of TEAMS_HTTP_CONTROLLERS) DI.register(c as Class<BaseController>).as(BaseController);
  await DI.resolve(Controllers);
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();

  running = { server, port: (server.Server.address() as AddressInfo).port };
  return running.port;
}

export async function stopTeamsApp(): Promise<void> {
  if (!running) return;
  const { server } = running;
  running = undefined;
  await server.stop();
  await ((await DI.resolve(Orm)) as Orm).dispose();
}

export function appPort(): number {
  if (!running) throw new Error('teams-http test app is not running (test/hooks.ts starts it)');
  return running.port;
}
```

Create `packages/teams-http/test/support/client.ts`:

```ts
import chai from 'chai';
import { AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { EMAIL_HEADER, USER_HEADER, appPort } from './app.js';

export interface Res {
  readonly status: number;
  readonly body: any;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One request to the running app; `as` sends `x-user: <as>`, `email` a verified email for it. */
export async function send(method: Method, path: string, opts: { readonly as?: string; readonly email?: string; readonly body?: unknown } = {}): Promise<Res> {
  const origin = `http://127.0.0.1:${appPort()}`;
  const agent = chai.request(origin);
  let call = method === 'GET' ? agent.get(path) : method === 'POST' ? agent.post(path) : method === 'PATCH' ? agent.patch(path) : agent.delete(path);
  call = call.set('Accept', 'application/json');
  // A CSRF guard, when an installed package registers one, refuses an unsafe request from another origin.
  if (method !== 'GET') call = call.set('Origin', origin);
  if (opts.as !== undefined) call = call.set(USER_HEADER, opts.as);
  if (opts.email !== undefined) call = call.set(EMAIL_HEADER, opts.email);
  const res = opts.body === undefined ? await call : await call.send(opts.body as object);
  return { status: res.status, body: res.body, headers: res.headers as Record<string, string | undefined> };
}

export interface Client {
  get(path: string): Promise<Res>;
  post(path: string, body?: unknown): Promise<Res>;
  patch(path: string, body?: unknown): Promise<Res>;
  del(path: string): Promise<Res>;
}

export function as(user: string, email?: string): Client {
  const who = { as: user, ...(email !== undefined ? { email } : {}) };
  return {
    get: (path) => send('GET', path, who),
    post: (path, body = {}) => send('POST', path, { ...who, body }),
    patch: (path, body = {}) => send('PATCH', path, { ...who, body }),
    del: (path) => send('DELETE', path, who),
  };
}

let seq = 0;

/** An id or slug no other case uses: all suites share one database. Lower-case, so it is a valid slug. */
export const uniq = (prefix: string): string => `${prefix}-${++seq}-${Date.now().toString(36)}`;

export const teamRef = (id: string): ResourceRef => ({ type: 'team', id });
export const groupRef = (id: string): ResourceRef => ({ type: 'group', id });
export const subjectPath = (user: string): string => encodeURIComponent(`user:${user}`);

/** Grants `role` at `scope` to `user:<user>` as SYSTEM, past every guard. */
export async function grantAt(user: string, role: string, scope: ResourceRef): Promise<void> {
  const admin = ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const [result] = await admin.execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id: user }, role, scope }], { reason: 'teams-http test seed' });
  if (!result.ok) throw new Error(`seed ${role} for ${user}: ${result.error.code} ${result.error.message}`);
}

/** A fresh user holding `test.platform` (team:create) at $global. */
export async function platformUser(): Promise<string> {
  const id = uniq('platform');
  await grantAt(id, 'test.platform', GLOBAL);
  return id;
}

/** POST /teams as `owner`; the answer's team. */
export async function createTeam(owner: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await as(owner).post('/teams', { slug: uniq('team'), name: 'Team', ...body });
  if (res.status !== 200) throw new Error(`createTeam: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A root team and its owner, a fresh platform user. */
export async function ownedTeam(): Promise<{ readonly owner: string; readonly team: any }> {
  const owner = await platformUser();
  return { owner, team: await createTeam(owner) };
}
```

Create `packages/teams-http/test/hooks.ts`:

```ts
import { startTeamsApp, stopTeamsApp } from './support/app.js';

// One app and one database for the whole run; cases keep apart by fresh ids (support/client.ts uniq).
before(async function () {
  this.timeout(120_000);
  await startTeamsApp();
});

after(async () => {
  await stopTeamsApp();
});
```

In `packages/teams-http/.mocharc.json` replace the `file` entry with:

```json
  "file": [
    "test/setup.ts",
    "test/hooks.ts"
  ],
```

- [ ] **Step 2: Write the failing route tests**

Create `packages/teams-http/test/teams.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { as, createTeam, grantAt, ownedTeam, platformUser, send, teamRef, uniq } from './support/client.js';

describe('teams routes', function () {
  this.timeout(30_000);

  describe('POST /teams', () => {
    it('creates a root team; the creator owns it', async () => {
      const owner = await platformUser();
      const slug = uniq('team');
      const res = await as(owner).post('/teams', { slug, name: 'Red', description: 'the red team' });
      expect(res.status).to.eq(200);
      expect(res.body).to.include({ slug, name: 'Red', description: 'the red team', parentId: null, archivedAt: null, deletedAt: null });
      expect(res.body.id).to.be.a('string').that.is.not.empty;
      expect(res.body.createdAt).to.be.a('string');
      expect((await as(owner).patch(`/teams/${res.body.id}`, { name: 'Crimson' })).status).to.eq(200);
    });

    it('answers 401 without a principal and 403 without team:create anywhere', async () => {
      expect((await send('POST', '/teams', { body: { slug: uniq('team'), name: 'x' } })).status).to.eq(401);
      expect((await as(uniq('nobody')).post('/teams', { slug: uniq('team'), name: 'x' })).status).to.eq(403);
    });

    it('refuses a root team to the owner of another team (team:create at $global, checked by the service)', async () => {
      const other = uniq('owner');
      const { team } = await ownedTeam();
      await grantAt(other, 'team.owner', teamRef(team.id));
      expect((await as(other).post('/teams', { slug: uniq('team'), name: 'x' })).status).to.eq(403);
    });

    it('creates a sub-team for the parent owner and refuses a member of the parent', async () => {
      const { owner, team } = await ownedTeam();
      const child = await as(owner).post('/teams', { slug: uniq('team'), name: 'Child', parentId: team.id });
      expect(child.status).to.eq(200);
      expect(child.body.parentId).to.eq(team.id);

      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).post('/teams', { slug: uniq('team'), name: 'x', parentId: team.id })).status).to.eq(403);
    });

    it('validates the body against the CreateTeamBody schema', async () => {
      const owner = await platformUser();
      for (const body of [{ name: 'no slug' }, { slug: 'Bad Slug', name: 'x' }, { slug: uniq('team'), name: '' }, { slug: uniq('team'), name: 'x', color: 'red' }]) {
        expect((await as(owner).post('/teams', body)).status, JSON.stringify(body)).to.eq(400);
      }
    });

    it('answers 409 conflict for a taken slug', async () => {
      const owner = await platformUser();
      const slug = uniq('team');
      expect((await as(owner).post('/teams', { slug, name: 'a' })).status).to.eq(200);
      const again = await as(owner).post('/teams', { slug, name: 'b' });
      expect(again.status).to.eq(409);
      expect(again.body.error.code).to.eq('conflict');
    });
  });

  describe('GET /teams', () => {
    it('lists only the teams the caller can read, with a total', async () => {
      const a = await ownedTeam();
      await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(a.team.id));
      const res = await as(alice).get('/teams');
      expect(res.status).to.eq(200);
      expect(res.body.items.map((t: any) => t.id)).to.deep.eq([a.team.id]);
      expect(res.body.total).to.eq(1);
    });

    it('filters by parentId, or to the root teams, and pages', async () => {
      const owner = await platformUser();
      const parent = await createTeam(owner);
      const child = await createTeam(owner, { parentId: parent.id });

      expect((await as(owner).get(`/teams?parentId=${parent.id}`)).body.items.map((t: any) => t.id)).to.deep.eq([child.id]);
      const roots = (await as(owner).get('/teams?root=true')).body.items.map((t: any) => t.id);
      expect(roots).to.include(parent.id);
      expect(roots).to.not.include(child.id);
      expect((await as(owner).get(`/teams?root=true&parentId=${parent.id}`)).status).to.eq(400);

      const first = await as(owner).get('/teams?size=1');
      const second = await as(owner).get('/teams?size=1&page=1');
      expect(first.body.items).to.have.length(1);
      expect(first.body.total).to.eq(2);
      expect([first.body.items[0].id, second.body.items[0].id]).to.have.members([parent.id, child.id]);
      expect((await as(owner).get('/teams?size=0')).status).to.eq(400);
      expect((await as(owner).get('/teams?page=-1')).status).to.eq(400);
    });

    it('answers 403 to a caller who can read no team', async () => {
      expect((await as(uniq('nobody')).get('/teams')).status).to.eq(403);
    });
  });

  describe('GET, PATCH, DELETE /teams/:team', () => {
    it('reads a team for a member and refuses an outsider', async () => {
      const { team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      const res = await as(alice).get(`/teams/${team.id}`);
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq(team);
      expect((await as(uniq('bob')).get(`/teams/${team.id}`)).status).to.eq(403);
    });

    it('changes a team for the owner, refuses a member, and refuses an empty patch', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'x' })).status).to.eq(403);
      const res = await as(owner).patch(`/teams/${team.id}`, { name: 'Renamed', description: null });
      expect(res.status).to.eq(200);
      expect(res.body).to.include({ id: team.id, name: 'Renamed', description: null, slug: team.slug });
      expect((await as(owner).patch(`/teams/${team.id}`, {})).status).to.eq(400);
    });

    it('deletes a team for the owner; it is gone afterwards', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).del(`/teams/${team.id}`)).status).to.eq(403);
      const res = await as(owner).del(`/teams/${team.id}`);
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ ok: true });
      const gone = await as(owner).get(`/teams/${team.id}`);
      expect(gone.status).to.eq(404);
      expect(gone.body.error.code).to.eq('not_found');
    });

    it('restores a deleted team for the owner and refuses a member', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).del(`/teams/${team.id}`)).status).to.eq(200);
      expect((await as(alice).post(`/teams/${team.id}/restore`)).status).to.eq(403);
      const back = await as(owner).post(`/teams/${team.id}/restore`);
      expect(back.status).to.eq(200);
      expect(back.body).to.include({ id: team.id, deletedAt: null });
      expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(200);
    });
  });

  describe('POST /teams/:team/archive|unarchive|move|transfer', () => {
    it('archives and unarchives for the owner and refuses a member', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(alice).post(`/teams/${team.id}/archive`)).status).to.eq(403);
      const archived = await as(owner).post(`/teams/${team.id}/archive`);
      expect(archived.status).to.eq(200);
      expect(archived.body.archivedAt).to.be.a('string');
      expect((await as(alice).get(`/teams/${team.id}`)).status, 'team:read stays allowed on an archived team').to.eq(200);
      expect((await as(owner).patch(`/teams/${team.id}`, { name: 'x' })).status, 'teams.archived.write denies team:update').to.eq(403);
      const back = await as(owner).post(`/teams/${team.id}/unarchive`);
      expect(back.status).to.eq(200);
      expect(back.body.archivedAt).to.eq(null);
    });

    it('moves a team under another and back to the root', async () => {
      const owner = await platformUser();
      const parent = await createTeam(owner);
      const team = await createTeam(owner);
      const moved = await as(owner).post(`/teams/${team.id}/move`, { parentId: parent.id });
      expect(moved.status).to.eq(200);
      expect(moved.body.parentId).to.eq(parent.id);
      expect((await as(owner).get(`/teams?parentId=${parent.id}`)).body.items.map((t: any) => t.id)).to.deep.eq([team.id]);
      expect((await as(owner).post(`/teams/${team.id}/move`, { parentId: null })).body.parentId).to.eq(null);
      expect((await as(owner).post(`/teams/${team.id}/move`, {})).status).to.eq(400);
    });

    it('transfers ownership to a user; by default the old owner stays team.admin', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `group:${uniq('g')}` })).status).to.eq(400);
      const res = await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${alice}` });
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ ok: true });
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'Mine' })).status).to.eq(200);

      const members = (await as(alice).get(`/teams/${team.id}/members`)).body.items.map((m: any) => ({ subject: m.subject, role: m.role }));
      expect(members).to.deep.include({ subject: `user:${owner}`, role: 'team.admin' });
      expect((await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${uniq('bob')}` })).status, 'team.admin still manages members').to.eq(200);
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${owner}` })).status, 'no team:ownership.transfer').to.eq(403);
      expect((await as(owner).del(`/teams/${team.id}`)).status, 'no team:delete').to.eq(403);
    });

    it('transfers ownership with keepAs null; the old owner loses the team', async () => {
      const { owner, team } = await ownedTeam();
      const alice = uniq('alice');
      await grantAt(alice, 'team.member', teamRef(team.id));
      expect((await as(owner).post(`/teams/${team.id}/transfer`, { to: `user:${alice}`, keepAs: null })).status).to.eq(200);
      expect((await as(alice).patch(`/teams/${team.id}`, { name: 'Mine' })).status).to.eq(200);
      expect((await as(owner).get(`/teams/${team.id}`)).status).to.eq(403);
      expect((await as(owner).patch(`/teams/${team.id}`, { name: 'Not mine' })).status).to.eq(403);
    });
  });
});
```

The third case's `other` holds `team.owner` (so `team:create`) at one team only: the type-level route check passes and TeamService must refuse a root team.

Run: `cd packages/teams-http && npm test`
Expected: FAIL. The app boots with no controller mounted (`TEAMS_HTTP_CONTROLLERS` is still empty): `10 passing`, `17 failing`, each with a 404 where the case expects another status. A failure in the root `before` hook instead means the stack does not boot: read its error (a missing L14 registration, a migration error) and fix `test/support/app.ts` against L14's stack before going on.

- [ ] **Step 3: Extractors and body schemas**

Create `packages/teams-http/src/http/refs.ts`:

```ts
import { fromParam } from '@spinajs/authz-http';

export const TEAM = fromParam('team', 'team');
export const GROUP = fromParam('group', 'group');
```

Create `packages/teams-http/src/schemas/bodies.ts`:

```ts
import { Schema } from '@spinajs/validation';

import { SUBJECT_PATTERN } from '../http/subjects.js';

// Fresh objects per use: http-swagger rewrites the schema nodes it walks.
export const slugSchema = () => ({ type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$', maxLength: 64, description: 'lower-case letters, digits and inner hyphens' });
export const nameSchema = () => ({ type: 'string', minLength: 1, maxLength: 128 });
export const descriptionSchema = () => ({ type: 'string', nullable: true, maxLength: 10000 });
export const idSchema = () => ({ type: 'string', minLength: 1, maxLength: 36 });
export const nullableIdSchema = () => ({ ...idSchema(), nullable: true });
export const subjectSchema = () => ({ type: 'string', pattern: SUBJECT_PATTERN, maxLength: 200, description: '`user:<id>`, `group:<id>` or `team:<id>`' });

export const object = (required: readonly string[], properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties, ...extra });

@Schema(object(['slug', 'name'], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema(), parentId: { ...nullableIdSchema(), description: 'the parent team; absent or null for a root team' } }, { title: 'CreateTeamBody' }))
export class CreateTeamBody {
  public slug: string;
  public name: string;
  public description?: string | null;
  public parentId?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object([], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema() }, { title: 'UpdateTeamBody', minProperties: 1 }))
export class UpdateTeamBody {
  public slug?: string;
  public name?: string;
  public description?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['parentId'], { parentId: { ...nullableIdSchema(), description: 'the new parent team; null makes it a root team' } }, { title: 'MoveTeamBody' }))
export class MoveTeamBody {
  public parentId: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(
  object(
    ['to'],
    {
      to: { type: 'string', pattern: '^user:.+$', maxLength: 200, description: '`user:<id>`, the new owner' },
      keepAs: { type: 'string', nullable: true, minLength: 1, maxLength: 128, description: 'the role the previous owner keeps; default team.admin, null for none' },
    },
    { title: 'TransferTeamBody' },
  ),
)
export class TransferTeamBody {
  public to: string;
  public keepAs?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
```

- [ ] **Step 4: The controller**

Create `packages/teams-http/src/controllers/TeamsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { TeamService } from '@spinajs/teams';

import { done } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { parseUser } from '../http/subjects.js';
import { CreateTeamBody, MoveTeamBody, TransferTeamBody, UpdateTeamBody } from '../schemas/bodies.js';

/**
 * Teams: list, create, read, change, archive, move, transfer ownership, delete, restore.
 * Every route sits on `@Access`: at the addressed team, or type-level for the list and the create. TeamService checks the exact permission again, including what a route cannot see (`team:create` at the parent named in the body). The list comes from `.accessible('team:read')`. A refused service call answers `{ error: { code, message, field? } }`.
 * @tags Teams
 */
@BasePath('teams')
export class TeamsController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * List teams
   * The live teams the caller may read (`.accessible('team:read')` in TeamService). A caller who can read no team at all is refused (403): GET /user/teams answers "my teams" for everyone.
   * @param parentId Only the direct sub-teams of this team
   * @param root `true`: only root teams (not with parentId)
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsTeamPage} One page of teams
   * @response 400 Bad request: a query parameter does not match its schema, or {TeamsError} invalid_request (root with parentId)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: the caller can read no team
   */
  @Get('/')
  @Access('team:read')
  public async list(@CurrentPrincipal() caller: Principal, @Query({ type: 'string', minLength: 1 }) parentId?: string, @Query() root?: boolean, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => {
      if (root && parentId !== undefined) throw new InvalidArgument('root and parentId exclude each other', 'root');
      const parent = root ? { parentId: null } : parentId !== undefined ? { parentId } : {};
      return new Ok(await this.Teams.listTeams(caller, { ...parent, page: pageOf(page, size) }));
    });
  }

  /**
   * Create a team
   * Creates a team; the caller becomes its `team.owner`. A root team needs `team:create` at `$global`, a sub-team `team:create` at its parent (TeamService checks; the route checks that the caller holds `team:create` somewhere).
   * @response 200 {TeamsTeam} The new team
   * @response 400 Bad request: the body does not match CreateTeamBody, or {TeamsError} invalid_request
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:create` at the parent, or at `$global` for a root team
   * @response 404 {TeamsError} not_found: the parent team does not exist
   * @response 409 {TeamsError} conflict: the slug is taken
   */
  @Post('/')
  @Access('team:create')
  public async create(@CurrentPrincipal() caller: Principal, @Body() body: CreateTeamBody) {
    return guarded(async () => new Ok(await this.Teams.createTeam(caller, definedOnly({ slug: body.slug, name: body.name, description: body.description, parentId: body.parentId }))));
  }

  /**
   * Read a team
   * @param team The team id
   * @response 200 {TeamsTeam} The team
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team (also for an id that does not exist)
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team')
  @Access('team:read', { resource: TEAM })
  public async get(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.getTeam(caller, team)));
  }

  /**
   * Change a team
   * Changes the slug, name or description; `description: null` clears it.
   * @param team The team id
   * @response 200 {TeamsTeam} The changed team
   * @response 400 Bad request: the body does not match UpdateTeamBody (at least one key)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:update` at the team (or the team is archived)
   * @response 404 {TeamsError} not_found: the team was deleted
   * @response 409 {TeamsError} conflict: the slug is taken
   */
  @Patch(':team')
  @Access('team:update', { resource: TEAM })
  public async update(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: UpdateTeamBody) {
    return guarded(async () => new Ok(await this.Teams.updateTeam(caller, team, definedOnly({ slug: body.slug, name: body.name, description: body.description }))));
  }

  /**
   * Delete a team
   * Soft-deletes the team: writes under it freeze, and it is purged after `teams.deletion.graceDays`.
   * @param team The team id
   * @response 200 {TeamsOk} Deleted
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:delete` at the team
   * @response 404 {TeamsError} not_found: the team was deleted already
   */
  @Del(':team')
  @Access('team:delete', { resource: TEAM })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => {
      await this.Teams.deleteTeam(caller, team);
      return done();
    });
  }

  /**
   * Restore a team
   * Undoes a soft delete within the grace period; the team comes back archived if it was archived before. Refused while its parent is deleted.
   * @param team The team id
   * @response 200 {TeamsTeam} The restored team
   * @response 400 {TeamsError} invalid_request: the parent team is deleted
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:delete` at the team
   * @response 404 {TeamsError} not_found: no such team, or it was purged
   */
  @Post(':team/restore')
  @Access('team:delete', { resource: TEAM })
  public async restore(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.restoreTeam(caller, team)));
  }

  /**
   * Archive a team
   * Marks the team archived: creates, updates and deletes under it are refused, reads stay allowed.
   * @param team The team id
   * @response 200 {TeamsTeam} The archived team
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:archive` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/archive')
  @Access('team:archive', { resource: TEAM })
  public async archive(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.archiveTeam(caller, team)));
  }

  /**
   * Unarchive a team
   * @param team The team id
   * @response 200 {TeamsTeam} The team, no longer archived
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:archive` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/unarchive')
  @Access('team:archive', { resource: TEAM })
  public async unarchive(@CurrentPrincipal() caller: Principal, @Param() team: string) {
    return guarded(async () => new Ok(await this.Teams.unarchiveTeam(caller, team)));
  }

  /**
   * Move a team
   * Re-parents the team (`parentId`), or makes it a root team (`null`). Needs `team:create` at the new parent too (TeamService checks).
   * @param team The team id
   * @response 200 {TeamsTeam} The moved team
   * @response 400 Bad request: the body does not match MoveTeamBody, or {TeamsError} invalid_request / set_cycle (a move under itself)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:update` at the team, or no `team:create` at the new parent
   * @response 404 {TeamsError} not_found: the team or the new parent does not exist
   */
  @Post(':team/move')
  @Access('team:update', { resource: TEAM })
  public async move(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: MoveTeamBody) {
    return guarded(async () => new Ok(await this.Teams.moveTeam(caller, team, body.parentId)));
  }

  /**
   * Transfer ownership
   * Grants `team.owner` to the user in `to` and revokes it from the caller, in one batch. The caller keeps `keepAs` (default `team.admin`; `null`: nothing).
   * @param team The team id
   * @response 200 {TeamsOk} Transferred
   * @response 400 Bad request: the body does not match TransferTeamBody
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:ownership.transfer` at the team, or {TeamsError} a guard refusal (last_holder, escalation)
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Post(':team/transfer')
  @Access('team:ownership.transfer', { resource: TEAM })
  public async transfer(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: TransferTeamBody) {
    return guarded(async () => {
      await this.Teams.transferOwnership(caller, team, parseUser(body.to, 'to'), definedOnly({ keepAs: body.keepAs }));
      return done();
    });
  }
}
```

Replace `packages/teams-http/src/controller-list.ts` with:

```ts
import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { TeamsController } from './controllers/TeamsController.js';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([TeamsController]);
```

Append to `packages/teams-http/src/index.ts`:

```ts
export * from './http/refs.js';
export * from './schemas/bodies.js';
export * from './controllers/TeamsController.js';
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `27 passing` (10 helpers, 17 teams routes).

If the case "refuses a root team to the owner of another team" answers 200, L14's `createTeam` does not check `team:create` at `$global` for a root team (teams §4): report it to L14, do not change the expectation.

- [ ] **Step 6: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): team routes with @Access and schema-validated bodies; shared SQLite test app"
```

---

### Task 3: Team members routes

**Files:**
- Create: `src/controllers/TeamMembersController.ts`, `test/members.test.ts`
- Modify: `src/schemas/bodies.ts`, `src/controller-list.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`membersJson`, `done`, `pageOf`, `pageQuery`, `sizeQuery`, `TEAM`), L14 `parseSubjectLabel`; L14 `TeamService.members`, `addTeamMember`, `setTeamRole`, `removeTeamMember`.
- Produces: `roleSchema()`; DTOs `AddTeamMemberBody { subject; role? }`, `SetRoleBody { role }`; `TeamMembersController`.

- [ ] **Step 1: Write the failing tests**

Create `packages/teams-http/test/members.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { as, grantAt, ownedTeam, send, subjectPath, teamRef, uniq } from './support/client.js';

const roles = (items: any[]) => items.map((m) => ({ subject: m.subject, role: m.role }));

describe('team members routes', function () {
  this.timeout(30_000);

  it('adds a member, who then reads the team; the list shows owner and member with their roles, paged', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(403);
    const added = await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${alice}` });
    expect(added.status).to.eq(200);
    expect(added.body).to.deep.eq({ ok: true });
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(200);

    const list = await as(alice).get(`/teams/${team.id}/members`);
    expect(list.status).to.eq(200);
    expect(roles(list.body.items)).to.deep.include({ subject: `user:${alice}`, role: 'team.member' });
    expect(roles(list.body.items)).to.deep.include({ subject: `user:${owner}`, role: 'team.owner' });
    expect(list.body.items[0].assignmentId).to.be.a('string');
    const page = await as(alice).get(`/teams/${team.id}/members?size=1&page=1`);
    expect(page.body.items).to.have.length(1);
    expect(page.body.total).to.eq(list.body.total);
    expect((await as(alice).get(`/teams/${team.id}/members?size=0`)).status).to.eq(400);
  });

  it('adds a member with a role', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${alice}`, role: 'team.admin' })).status).to.eq(200);
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'By admin' })).status).to.eq(200);
  });

  it("changes a member's role", async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'x' })).status).to.eq(403);
    const res = await as(owner).patch(`/teams/${team.id}/members/${subjectPath(alice)}`, { role: 'team.admin' });
    expect(res.status).to.eq(200);
    expect((await as(alice).patch(`/teams/${team.id}`, { name: 'By admin' })).status).to.eq(200);
    const list = roles((await as(owner).get(`/teams/${team.id}/members`)).body.items);
    expect(list).to.deep.include({ subject: `user:${alice}`, role: 'team.admin' });
    expect(list).to.not.deep.include({ subject: `user:${alice}`, role: 'team.member' });
  });

  it('refuses a plain member every write', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).post(`/teams/${team.id}/members`, { subject: `user:${uniq('bob')}` })).status).to.eq(403);
    expect((await as(alice).patch(`/teams/${team.id}/members/${subjectPath(owner)}`, { role: 'team.member' })).status).to.eq(403);
    expect((await as(alice).del(`/teams/${team.id}/members/${subjectPath(owner)}`)).status).to.eq(403);
  });

  it('refuses a malformed subject and an unknown role with 400', async () => {
    const { owner, team } = await ownedTeam();
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: 'alice' })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/members`, {})).status).to.eq(400);
    const badPath = await as(owner).del(`/teams/${team.id}/members/alice`);
    expect(badPath.status).to.eq(400);
    expect(badPath.body.error).to.include({ code: 'invalid_request', field: 'subject' });
    expect((await as(owner).post(`/teams/${team.id}/members`, { subject: `user:${uniq('bob')}`, role: 'no.such.role' })).status).to.eq(400);
  });

  it("refuses a role above the caller's own (escalation)", async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    const bob = uniq('bob');
    await grantAt(alice, 'team.admin', teamRef(team.id));
    await grantAt(bob, 'team.member', teamRef(team.id));
    const res = await as(alice).patch(`/teams/${team.id}/members/${subjectPath(bob)}`, { role: 'team.owner' });
    expect(res.status).to.eq(403);
    expect(res.body.error.code).to.eq('escalation');
  });

  it('keeps the last owner (last_holder)', async () => {
    const { owner, team } = await ownedTeam();
    const res = await as(owner).del(`/teams/${team.id}/members/${subjectPath(owner)}`);
    expect(res.status).to.eq(403);
    expect(res.body.error.code).to.eq('last_holder');
    expect((await as(owner).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it('removes a member, who can no longer read the team', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    const res = await as(owner).del(`/teams/${team.id}/members/${subjectPath(alice)}`);
    expect(res.status).to.eq(200);
    expect((await as(alice).get(`/teams/${team.id}`)).status).to.eq(403);
  });

  it('answers 401 without a principal and 403 to an outsider listing members', async () => {
    const { team } = await ownedTeam();
    expect((await send('GET', `/teams/${team.id}/members`)).status).to.eq(401);
    expect((await as(uniq('bob')).get(`/teams/${team.id}/members`)).status).to.eq(403);
  });
});
```

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/members.test.ts`
Expected: FAIL, `9 failing` (404: no members route).

- [ ] **Step 2: Bodies**

Append to `packages/teams-http/src/schemas/bodies.ts`:

```ts
export const roleSchema = () => ({ type: 'string', minLength: 1, maxLength: 128, description: 'a role name, e.g. team.member, team.admin' });

@Schema(object(['subject'], { subject: subjectSchema(), role: { ...roleSchema(), description: 'default team.member' } }, { title: 'AddTeamMemberBody' }))
export class AddTeamMemberBody {
  public subject: string;
  public role?: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['role'], { role: roleSchema() }, { title: 'SetRoleBody' }))
export class SetRoleBody {
  public role: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
```

- [ ] **Step 3: The controller**

Create `packages/teams-http/src/controllers/TeamMembersController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { TeamService, parseSubjectLabel } from '@spinajs/teams';

import { done, membersJson } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { AddTeamMemberBody, SetRoleBody } from '../schemas/bodies.js';

/**
 * Members of a team: users, groups and teams holding a role at the team.
 * Every route sits on `@Access` at the team: `team:read` to list, `team:members.manage` to add and remove, `team:roles.manage` to change a role. The writes run as the caller, so AuthzAdmin's guard keeps one `team.owner` per team (`last_holder`) and refuses a role above the caller's own (`escalation`). Path subjects are URL-encoded `user:<id>`, `group:<id>` or `team:<id>`.
 * @tags Team members
 */
@BasePath('teams')
export class TeamMembersController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * List members
   * Every assignment at the team, one entry per subject and role.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsMemberPage} One page of members
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/members')
  @Access('team:read', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(membersJson(await this.Teams.members(caller, team, pageOf(page, size)))));
  }

  /**
   * Add a member
   * Assigns `role` (default `team.member`) at the team to the subject.
   * @param team The team id
   * @response 200 {TeamsOk} Added
   * @response 400 Bad request: the body does not match AddTeamMemberBody, or {TeamsError} an AuthzAdmin validation code (unknown_role, wrong_scope_type, not_assignable)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:members.manage` at the team, or {TeamsError} escalation
   * @response 404 {TeamsError} not_found: the team was deleted
   * @response 409 {TeamsError} conflict: the subject holds that role already
   */
  @Post(':team/members')
  @Access('team:members.manage', { resource: TEAM })
  public async add(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: AddTeamMemberBody) {
    return guarded(async () => {
      await this.Teams.addTeamMember(caller, team, parseSubjectLabel(body.subject), body.role);
      return done();
    });
  }

  /**
   * Change a member's role
   * Replaces the subject's roles at the team with `role`, in one batch.
   * @param team The team id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Changed
   * @response 400 Bad request: the body does not match SetRoleBody, or {TeamsError} invalid_request (a malformed subject) or an AuthzAdmin validation code
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:roles.manage` at the team, or {TeamsError} escalation, last_holder
   * @response 404 {TeamsError} not_found: the team was deleted or the subject is no member
   */
  @Patch(':team/members/:subject')
  @Access('team:roles.manage', { resource: TEAM })
  public async setRole(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() subject: string, @Body() body: SetRoleBody) {
    return guarded(async () => {
      await this.Teams.setTeamRole(caller, team, parseSubjectLabel(subject), body.role);
      return done();
    });
  }

  /**
   * Remove a member
   * Revokes every role of the subject at the team.
   * @param team The team id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Removed
   * @response 400 {TeamsError} invalid_request: a malformed subject
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:members.manage` at the team, or {TeamsError} last_holder, self_lockout
   * @response 404 {TeamsError} not_found: the team was deleted or the subject is no member
   */
  @Del(':team/members/:subject')
  @Access('team:members.manage', { resource: TEAM })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() subject: string) {
    return guarded(async () => {
      await this.Teams.removeTeamMember(caller, team, parseSubjectLabel(subject));
      return done();
    });
  }
}
```

In `src/controller-list.ts` add `import { TeamMembersController } from './controllers/TeamMembersController.js';` and make the list `Object.freeze([TeamsController, TeamMembersController])`. Append to `src/index.ts`:

```ts
export * from './controllers/TeamMembersController.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `36 passing`.

A failing `escalation` or `last_holder` case that answers another 403 code means L14 refuses before AuthzAdmin with its own check; a 400 or 500 means the failed batch is not rethrown as `AuthzAdminFailure` (L14 Global Constraints): report it to L14 with the answer body.

- [ ] **Step 5: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): team member routes"
```

---

### Task 4: Groups and group members routes

**Files:**
- Create: `src/controllers/TeamGroupsController.ts`, `src/controllers/GroupsController.ts`, `test/groups.test.ts`
- Modify: `src/schemas/bodies.ts`, `src/controller-list.ts`, `src/index.ts`, `test/support/client.ts`

**Interfaces:**
- Consumes: Tasks 1–3; L14 `GroupService` (`listGroups`, `getGroup`, `createGroup`, `updateGroup`, `moveGroup`, `deleteGroup`, `members`, `addGroupMember`, `removeGroupMember`).
- Produces: DTOs `CreateGroupBody`, `UpdateGroupBody`, `MoveGroupBody { teamId?; parentId }`, `AddGroupMemberBody`; `TeamGroupsController` (`/teams/:team/groups`), `GroupsController` (`/groups/...`); test helper `createGroup(owner, teamId, body?)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/teams-http/test/support/client.ts`:

```ts
/** POST /teams/:team/groups as `owner`; the answer's group. */
export async function createGroup(owner: string, teamId: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await as(owner).post(`/teams/${teamId}/groups`, { slug: uniq('group'), name: 'Group', ...body });
  if (res.status !== 200) throw new Error(`createGroup: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
```

Create `packages/teams-http/test/groups.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { as, createGroup, createTeam, grantAt, ownedTeam, platformUser, subjectPath, teamRef, uniq } from './support/client.js';

describe('groups routes', function () {
  this.timeout(30_000);

  it('creates a group in a team; a team member reads it, an outsider is refused', async () => {
    const { owner, team } = await ownedTeam();
    const slug = uniq('group');
    const res = await as(owner).post(`/teams/${team.id}/groups`, { slug, name: 'Devs' });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ teamId: team.id, parentId: null, slug, name: 'Devs', description: null });

    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).get(`/groups/${res.body.id}`)).body).to.deep.eq(res.body);
    expect((await as(uniq('bob')).get(`/groups/${res.body.id}`)).status).to.eq(403);
  });

  it('creates a nested group and refuses a parent group of another team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const outer = await createGroup(owner, team.id);
    const inner = await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'Inner', parentId: outer.id });
    expect(inner.status).to.eq(200);
    expect(inner.body.parentId).to.eq(outer.id);
    const foreign = await createGroup(owner, other.id);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x', parentId: foreign.id })).status).to.eq(400);
  });

  it('refuses group creation to a plain member and validates the body', async () => {
    const { owner, team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x' })).status).to.eq(403);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { name: 'no slug' })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/groups`, { slug: uniq('group'), name: 'x', teamId: 'x' })).status).to.eq(400);
  });

  it("lists the team's groups only", async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const mine = [await createGroup(owner, team.id), await createGroup(owner, team.id)];
    await createGroup(owner, other.id);

    const all = await as(owner).get(`/teams/${team.id}/groups`);
    expect(all.status).to.eq(200);
    expect(all.body.items.map((g: any) => g.id)).to.have.members(mine.map((g) => g.id));
    expect(all.body.total).to.eq(2);
    expect((await as(uniq('bob')).get(`/teams/${team.id}/groups`)).status).to.eq(403);
  });

  it('changes a group for the owner and refuses a plain member', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).patch(`/groups/${group.id}`, { name: 'x' })).status).to.eq(403);
    const res = await as(owner).patch(`/groups/${group.id}`, { name: 'Renamed' });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ id: group.id, name: 'Renamed' });
    expect((await as(owner).patch(`/groups/${group.id}`, {})).status).to.eq(400);
  });

  it('adds a group member, who reaches the team through the group, and removes them', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const carol = uniq('carol');
    expect((await as(carol).get(`/teams/${team.id}`)).status).to.eq(403);

    expect((await as(owner).post(`/groups/${group.id}/members`, { subject: `user:${carol}` })).status).to.eq(200);
    expect((await as(carol).get(`/teams/${team.id}`)).status, 'membership flows up: group -> team').to.eq(200);
    const members = await as(carol).get(`/groups/${group.id}/members`);
    expect(members.status).to.eq(200);
    expect(members.body.items.map((m: any) => ({ subject: m.subject, role: m.role }))).to.deep.include({ subject: `user:${carol}`, role: 'group.member' });

    expect((await as(carol).post(`/groups/${group.id}/members`, { subject: `user:${uniq('dave')}` })).status).to.eq(403);
    expect((await as(owner).del(`/groups/${group.id}/members/${subjectPath(carol)}`)).status).to.eq(200);
    expect((await as(carol).get(`/teams/${team.id}`)).status).to.eq(403);
  });

  it('moves a group to another team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const group = await createGroup(owner, team.id);
    const res = await as(owner).post(`/groups/${group.id}/move`, { teamId: other.id, parentId: null });
    expect(res.status).to.eq(200);
    expect(res.body).to.include({ id: group.id, teamId: other.id, parentId: null });
    expect((await as(owner).get(`/teams/${team.id}/groups`)).body.items).to.deep.eq([]);
    expect((await as(owner).post(`/groups/${group.id}/move`, { teamId: team.id })).status, 'parentId is required').to.eq(400);
  });

  it('deletes a group; it is gone afterwards', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const res = await as(owner).del(`/groups/${group.id}`);
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ ok: true });
    expect([403, 404]).to.include((await as(owner).get(`/groups/${group.id}`)).status);
  });
});
```

The last case accepts 403 or 404: groups are hard-deleted (L14 Decision 7), the delete clean-up drops the group's ancestors, so the owner's team role may no longer reach its id and the route check refuses before the service could answer 404.

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/groups.test.ts`
Expected: FAIL, `8 failing` (`createGroup: 404` or a 404 status).

- [ ] **Step 2: Bodies**

Append to `packages/teams-http/src/schemas/bodies.ts`:

```ts
@Schema(object(['slug', 'name'], { slug: { ...slugSchema(), description: 'unique among the groups of the team' }, name: nameSchema(), description: descriptionSchema(), parentId: { ...nullableIdSchema(), description: 'an outer group of the same team' } }, { title: 'CreateGroupBody' }))
export class CreateGroupBody {
  public slug: string;
  public name: string;
  public description?: string | null;
  public parentId?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object([], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema() }, { title: 'UpdateGroupBody', minProperties: 1 }))
export class UpdateGroupBody {
  public slug?: string;
  public name?: string;
  public description?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['parentId'], { teamId: { ...idSchema(), description: "the team to move the group to; default the group's team" }, parentId: { ...nullableIdSchema(), description: 'the new outer group (same team); null for none' } }, { title: 'MoveGroupBody' }))
export class MoveGroupBody {
  public teamId?: string;
  public parentId: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['subject'], { subject: subjectSchema() }, { title: 'AddGroupMemberBody' }))
export class AddGroupMemberBody {
  public subject: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
```

- [ ] **Step 3: The controllers**

Create `packages/teams-http/src/controllers/TeamGroupsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Param, Post, Query } from '@spinajs/http';
import { GroupService } from '@spinajs/teams';

import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { CreateGroupBody } from '../schemas/bodies.js';

/**
 * The groups of a team.
 * The list sits on `team:read` at the team and comes from `.accessible('group:read').within(team)` in GroupService; creating needs `group:create` at the team.
 * @tags Team groups
 */
@BasePath('teams')
export class TeamGroupsController extends BaseController {
  @Autoinject(GroupService)
  protected Groups: GroupService;

  /**
   * List the groups of a team
   * The groups at or below the team the caller may read, nested ones included.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsGroupPage} One page of groups
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:read` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/groups')
  @Access('team:read', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(await this.Groups.listGroups(caller, team, pageOf(page, size))));
  }

  /**
   * Create a group
   * Creates a group in the team (or inside `parentId`, a group of the same team) and links its members into the team's.
   * @param team The team id
   * @response 200 {TeamsGroup} The new group
   * @response 400 Bad request: the body does not match CreateGroupBody, or {TeamsError} invalid_request (a parent group of another team)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:create` at the team
   * @response 404 {TeamsError} not_found: the team or the parent group does not exist
   * @response 409 {TeamsError} conflict: the slug is taken in the team
   */
  @Post(':team/groups')
  @Access('group:create', { resource: TEAM })
  public async create(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: CreateGroupBody) {
    return guarded(async () => new Ok(await this.Groups.createGroup(caller, team, definedOnly({ slug: body.slug, name: body.name, description: body.description, parentId: body.parentId }))));
  }
}
```

Create `packages/teams-http/src/controllers/GroupsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Patch, Post, Query } from '@spinajs/http';
import { GroupService, parseSubjectLabel } from '@spinajs/teams';

import { done, membersJson } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { GROUP } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { AddGroupMemberBody, MoveGroupBody, UpdateGroupBody } from '../schemas/bodies.js';

/**
 * One group and its members.
 * Every route sits on `@Access` at the group: `group:read`, `group:update`, `group:delete`, `group:members.manage`. Team roles at the group's team reach the group (it is below the team). Path subjects are URL-encoded `user:<id>`, `group:<id>` or `team:<id>`.
 * @tags Groups
 */
@BasePath('groups')
export class GroupsController extends BaseController {
  @Autoinject(GroupService)
  protected Groups: GroupService;

  /**
   * Read a group
   * @param group The group id
   * @response 200 {TeamsGroup} The group
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:read` at the group (also for an id that does not exist)
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Get(':group')
  @Access('group:read', { resource: GROUP })
  public async get(@CurrentPrincipal() caller: Principal, @Param() group: string) {
    return guarded(async () => new Ok(await this.Groups.getGroup(caller, group)));
  }

  /**
   * Change a group
   * Changes the slug, name or description; `description: null` clears it.
   * @param group The group id
   * @response 200 {TeamsGroup} The changed group
   * @response 400 Bad request: the body does not match UpdateGroupBody (at least one key)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:update` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   * @response 409 {TeamsError} conflict: the slug is taken in the team
   */
  @Patch(':group')
  @Access('group:update', { resource: GROUP })
  public async update(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: UpdateGroupBody) {
    return guarded(async () => new Ok(await this.Groups.updateGroup(caller, group, definedOnly({ slug: body.slug, name: body.name, description: body.description }))));
  }

  /**
   * Delete a group
   * Deletes the group and unlinks its members from the team. A group with sub-groups is refused.
   * @param group The group id
   * @response 200 {TeamsOk} Deleted
   * @response 400 {TeamsError} invalid_request: the group has sub-groups
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:delete` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Del(':group')
  @Access('group:delete', { resource: GROUP })
  public async remove(@CurrentPrincipal() caller: Principal, @Param() group: string) {
    return guarded(async () => {
      await this.Groups.deleteGroup(caller, group);
      return done();
    });
  }

  /**
   * Move a group
   * Moves the group to another team (`teamId`) and/or under another group of its team (`parentId`, null for none), re-linking its members.
   * @param group The group id
   * @response 200 {TeamsGroup} The moved group
   * @response 400 Bad request: the body does not match MoveGroupBody, or {TeamsError} invalid_request / set_cycle
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:update` at the group, or no `group:create` at the target team
   * @response 404 {TeamsError} not_found: the group, team or parent does not exist
   */
  @Post(':group/move')
  @Access('group:update', { resource: GROUP })
  public async move(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: MoveGroupBody) {
    return guarded(async () => new Ok(await this.Groups.moveGroup(caller, group, definedOnly({ teamId: body.teamId, parentId: body.parentId }))));
  }

  /**
   * List group members
   * Every assignment at the group, one entry per subject and role.
   * @param group The group id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsMemberPage} One page of members
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:read` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   */
  @Get(':group/members')
  @Access('group:read', { resource: GROUP })
  public async members(@CurrentPrincipal() caller: Principal, @Param() group: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(membersJson(await this.Groups.members(caller, group, pageOf(page, size)))));
  }

  /**
   * Add a group member
   * Adds a user, group or team to the group.
   * @param group The group id
   * @response 200 {TeamsOk} Added
   * @response 400 Bad request: the body does not match AddGroupMemberBody, or {TeamsError} set_cycle / set_too_deep
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:members.manage` at the group
   * @response 404 {TeamsError} not_found: the group does not exist
   * @response 409 {TeamsError} conflict: the subject is a member already
   */
  @Post(':group/members')
  @Access('group:members.manage', { resource: GROUP })
  public async addMember(@CurrentPrincipal() caller: Principal, @Param() group: string, @Body() body: AddGroupMemberBody) {
    return guarded(async () => {
      await this.Groups.addGroupMember(caller, group, parseSubjectLabel(body.subject));
      return done();
    });
  }

  /**
   * Remove a group member
   * @param group The group id
   * @param subject `user:<id>`, `group:<id>` or `team:<id>`, URL-encoded
   * @response 200 {TeamsOk} Removed
   * @response 400 {TeamsError} invalid_request: a malformed subject
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `group:members.manage` at the group
   * @response 404 {TeamsError} not_found: the group does not exist or the subject is no member
   */
  @Del(':group/members/:subject')
  @Access('group:members.manage', { resource: GROUP })
  public async removeMember(@CurrentPrincipal() caller: Principal, @Param() group: string, @Param() subject: string) {
    return guarded(async () => {
      await this.Groups.removeGroupMember(caller, group, parseSubjectLabel(subject));
      return done();
    });
  }
}
```

In `src/controller-list.ts` import both and make the list `Object.freeze([TeamsController, TeamMembersController, TeamGroupsController, GroupsController])`. Append to `src/index.ts`:

```ts
export * from './controllers/TeamGroupsController.js';
export * from './controllers/GroupsController.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `44 passing`.

If the app fails to boot with an authz-http route error naming `TeamGroupsController.create` and `group:create`, L14's fragment registers `group:create` without `team` in its `types` (teams §7 checks it at the team): fix it in L14 (Contract issue 4), not here.

- [ ] **Step 5: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): group and group member routes"
```

---

### Task 5: Invitation routes and `POST /invitations/accept`

**Files:**
- Create: `src/controllers/TeamInvitationsController.ts`, `src/controllers/InvitationsController.ts`, `test/invitations.test.ts`
- Modify: `src/schemas/bodies.ts`, `src/controller-list.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–4; L14 `InvitationService` (`create`, `list`, `revoke`, `resend`, `accept`); authz-http `IsAuthenticated`; test `RecordingInvitationMailer` (Task 2).
- Produces: `INVITATION_MAX_HOURS = 8760`; DTOs `CreateInvitationBody { groupId?; role; email?; maxUses?; expiresInHours? }`, `AcceptInvitationBody { token }`; `TeamInvitationsController`, `InvitationsController`.

- [ ] **Step 1: Write the failing tests**

Create `packages/teams-http/test/invitations.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { RecordingInvitationMailer } from './support/app.js';
import { as, createGroup, createTeam, grantAt, ownedTeam, platformUser, send, teamRef, uniq } from './support/client.js';

const invite = (owner: string, teamId: string, body: Record<string, unknown> = {}) => as(owner).post(`/teams/${teamId}/invitations`, { role: 'team.member', ...body });
const lastMailTo = (address: string) => RecordingInvitationMailer.sent.filter((m) => m.to === address).pop();

describe('invitation routes', function () {
  this.timeout(30_000);

  it('creates a link invitation: the token is shown once, never stored by caches, never listed', async () => {
    const { owner, team } = await ownedTeam();
    const res = await invite(owner, team.id, { expiresInHours: 1 });
    expect(res.status).to.eq(200);
    expect(res.headers['cache-control']).to.eq('no-store');
    expect(res.body.token).to.be.a('string').that.is.not.empty;
    expect(res.body.invitation).to.include({ teamId: team.id, groupId: null, role: 'team.member', email: null, maxUses: null, uses: 0, revokedAt: null });
    expect(res.body.invitation).to.not.have.any.keys('token', 'tokenHash', 'token_hash');

    const list = await as(owner).get(`/teams/${team.id}/invitations`);
    expect(list.status).to.eq(200);
    expect(list.body.items.map((i: any) => i.id)).to.deep.eq([res.body.invitation.id]);
    expect(list.body.total).to.eq(1);
    expect(JSON.stringify(list.body)).to.not.include(res.body.token);
  });

  it('is for managers only', async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.member', teamRef(team.id));
    expect((await as(alice).get(`/teams/${team.id}/invitations`)).status).to.eq(403);
    expect((await invite(alice, team.id)).status).to.eq(403);
  });

  it('accepting joins the team, idempotently, and answers no-store', async () => {
    const { owner, team } = await ownedTeam();
    const { body } = await invite(owner, team.id);
    const dave = uniq('dave');
    const accepted = await as(dave).post('/invitations/accept', { token: body.token });
    expect(accepted.status).to.eq(200);
    expect(accepted.headers['cache-control']).to.eq('no-store');
    expect(accepted.body).to.deep.eq({ invitationId: body.invitation.id, teamId: team.id, groupId: null, role: 'team.member' });
    expect((await as(dave).get(`/teams/${team.id}`)).status).to.eq(200);
    expect((await as(dave).post('/invitations/accept', { token: body.token })).status).to.eq(200);
  });

  it('refuses a use beyond maxUses', async () => {
    const { owner, team } = await ownedTeam();
    const { body } = await invite(owner, team.id, { maxUses: 1 });
    expect((await as(uniq('dave')).post('/invitations/accept', { token: body.token })).status).to.eq(200);
    const second = await as(uniq('erin')).post('/invitations/accept', { token: body.token });
    expect(second.status).to.eq(409);
    expect(second.body.error.code).to.eq('invitation_used_up');
  });

  it('revokes an invitation, only through its own team', async () => {
    const owner = await platformUser();
    const team = await createTeam(owner);
    const other = await createTeam(owner);
    const { body } = await invite(owner, team.id);
    const id = body.invitation.id;

    const wrongTeam = await as(owner).del(`/teams/${other.id}/invitations/${id}`);
    expect(wrongTeam.status).to.eq(404);
    expect((await as(owner).del(`/teams/${team.id}/invitations/${id}`)).body).to.deep.eq({ ok: true });
    const refused = await as(uniq('dave')).post('/invitations/accept', { token: body.token });
    expect(refused.status).to.eq(409);
    expect(refused.body.error.code).to.eq('invitation_revoked');
    expect((await as(owner).get(`/teams/${team.id}/invitations`)).body.items[0].revokedAt).to.be.a('string');
  });

  it('answers an unknown token 404, no principal 401, no token 400', async () => {
    const unknown = await as(uniq('dave')).post('/invitations/accept', { token: 'not-a-token' });
    expect(unknown.status).to.eq(404);
    expect(unknown.body.error.code).to.eq('invitation_unknown');
    expect((await send('POST', '/invitations/accept', { body: { token: 'x' } })).status).to.eq(401);
    expect((await as(uniq('dave')).post('/invitations/accept', {})).status).to.eq(400);
  });

  it('a group invitation makes the user a group member', async () => {
    const { owner, team } = await ownedTeam();
    const group = await createGroup(owner, team.id);
    const { body } = await invite(owner, team.id, { groupId: group.id, role: 'group.member' });
    const frank = uniq('frank');
    const accepted = await as(frank).post('/invitations/accept', { token: body.token });
    expect(accepted.body).to.include({ teamId: team.id, groupId: group.id, role: 'group.member' });
    expect((await as(frank).get(`/groups/${group.id}`)).status).to.eq(200);
    expect((await as(frank).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it("cannot invite to a role above the inviter's own", async () => {
    const { team } = await ownedTeam();
    const alice = uniq('alice');
    await grantAt(alice, 'team.admin', teamRef(team.id));
    expect((await invite(alice, team.id)).status).to.eq(200);
    expect((await invite(alice, team.id, { role: 'team.owner' })).status).to.eq(403);
  });

  it('an email invitation is mailed and opens only for that verified email', async () => {
    const { owner, team } = await ownedTeam();
    const address = `${uniq('invitee')}@example.com`;
    const created = await invite(owner, team.id, { email: address });
    expect(created.status).to.eq(200);
    expect(created.body.invitation).to.include({ email: address, maxUses: 1 });
    expect(lastMailTo(address)?.token).to.eq(created.body.token);

    const refused = await as(uniq('gina')).post('/invitations/accept', { token: created.body.token });
    expect(refused.status).to.eq(403);
    expect(refused.body.error.code).to.eq('invitation_email_mismatch');
    const hal = uniq('hal');
    expect((await as(hal, address).post('/invitations/accept', { token: created.body.token })).status).to.eq(200);
    expect((await as(hal).get(`/teams/${team.id}`)).status).to.eq(200);
  });

  it('resending mails a new token; the old one stops working', async () => {
    const { owner, team } = await ownedTeam();
    const address = `${uniq('invitee')}@example.com`;
    const created = await invite(owner, team.id, { email: address });
    const resent = await as(owner).post(`/teams/${team.id}/invitations/${created.body.invitation.id}/resend`);
    expect(resent.status).to.eq(200);
    expect(resent.body.lastSentAt).to.be.a('string');
    expect(resent.body).to.not.have.any.keys('token', 'tokenHash', 'token_hash');

    const fresh = lastMailTo(address)!.token;
    expect(fresh).to.not.eq(created.body.token);
    const old = await as(uniq('ian'), address).post('/invitations/accept', { token: created.body.token });
    expect(old.status).to.eq(404);
    expect(old.body.error.code).to.eq('invitation_unknown');
    expect((await as(uniq('ian'), address).post('/invitations/accept', { token: fresh })).status).to.eq(200);
  });

  it('validates the body', async () => {
    const { owner, team } = await ownedTeam();
    expect((await invite(owner, team.id, { expiresInHours: 0 })).status).to.eq(400);
    expect((await invite(owner, team.id, { maxUses: 0 })).status).to.eq(400);
    expect((await invite(owner, team.id, { email: 'not an email' })).status).to.eq(400);
    expect((await invite(owner, team.id, { teamId: team.id })).status).to.eq(400);
    expect((await as(owner).post(`/teams/${team.id}/invitations`, {})).status).to.eq(400);
  });
});
```

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/invitations.test.ts`
Expected: FAIL, `11 failing` (404: no invitation routes).

- [ ] **Step 2: Bodies**

Append to `packages/teams-http/src/schemas/bodies.ts`:

```ts
export const INVITATION_MAX_HOURS = 8760;

@Schema(
  object(
    ['role'],
    {
      groupId: { ...idSchema(), description: 'join this group of the team instead of the team' },
      role: { ...roleSchema(), description: 'assigned on accept: a team role, or a group role with groupId; the inviter must be able to grant it' },
      email: { type: 'string', format: 'email', maxLength: 255, description: 'only this verified email may accept; absent for a shareable link' },
      maxUses: { type: 'integer', minimum: 1, nullable: true, description: 'default 1 for an email invitation, unlimited for a link; null for unlimited until expiry' },
      expiresInHours: { type: 'integer', minimum: 1, maximum: INVITATION_MAX_HOURS, description: 'default teams.invitations.defaultTtlHours' },
    },
    { title: 'CreateInvitationBody' },
  ),
)
export class CreateInvitationBody {
  public groupId?: string;
  public role: string;
  public email?: string;
  public maxUses?: number | null;
  public expiresInHours?: number;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['token'], { token: { type: 'string', minLength: 1, maxLength: 256, description: 'the token of the create answer or the invitation mail' } }, { title: 'AcceptInvitationBody' }))
export class AcceptInvitationBody {
  public token: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
```

- [ ] **Step 3: The controllers**

Create `packages/teams-http/src/controllers/TeamInvitationsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { Access, CurrentPrincipal } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Del, Get, Ok, Param, Post, Query } from '@spinajs/http';
import { InvitationService } from '@spinajs/teams';

import { NO_STORE, done } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { TEAM } from '../http/refs.js';
import { definedOnly, pageOf, pageQuery, sizeQuery } from '../http/request.js';
import { CreateInvitationBody } from '../schemas/bodies.js';

/**
 * Invitations to a team or one of its groups.
 * Every route sits on `team:invitations.manage` at the team. The inviter must be able to grant the role (no escalation through invitations). The token is shown once, in the create answer sent with `Cache-Control: no-store`, or in the invitation mail; it is stored only as an HMAC.
 * @tags Team invitations
 */
@BasePath('teams')
export class TeamInvitationsController extends BaseController {
  @Autoinject(InvitationService)
  protected Invitations: InvitationService;

  /**
   * List invitations
   * The team's invitations, revoked and expired ones included. A listing never carries a token or its hash.
   * @param team The team id
   * @param page Page number from 0 (default 0)
   * @param size Page size, 1 to 200 (default 50)
   * @response 200 {TeamsInvitationPage} One page of invitations
   * @response 400 Bad request: a query parameter does not match its schema
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found: the team was deleted
   */
  @Get(':team/invitations')
  @Access('team:invitations.manage', { resource: TEAM })
  public async list(@CurrentPrincipal() caller: Principal, @Param() team: string, @Query(pageQuery()) page?: number, @Query(sizeQuery()) size?: number) {
    return guarded(async () => new Ok(await this.Invitations.list(caller, team, pageOf(page, size))));
  }

  /**
   * Create an invitation
   * Invites to the team (or to `groupId`) with `role`. With `email` the invitation is mailed and only that verified email may accept it; without, the token is a shareable link. The answer holds the token, shown once, with `Cache-Control: no-store`.
   * @param team The team id
   * @response 200 {TeamsInvitationCreated} The invitation and its token
   * @response 400 Bad request: the body does not match CreateInvitationBody, or {TeamsError} invalid_request / an AuthzAdmin validation code (a role that does not fit the scope)
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team, or {TeamsError} escalation: the inviter cannot grant the role
   * @response 404 {TeamsError} not_found: the team or the group does not exist
   */
  @Post(':team/invitations')
  @Access('team:invitations.manage', { resource: TEAM })
  public async create(@CurrentPrincipal() caller: Principal, @Param() team: string, @Body() body: CreateInvitationBody) {
    return guarded(async () => {
      const { invitation, token } = await this.Invitations.create(caller, definedOnly({ teamId: team, groupId: body.groupId, role: body.role, email: body.email, maxUses: body.maxUses, expiresInHours: body.expiresInHours }));
      return new Ok({ invitation, token }, { Headers: [NO_STORE] });
    });
  }

  /**
   * Revoke an invitation
   * Its token opens nothing from then on; roles already given by it stay.
   * @param team The team id
   * @param invitation The invitation id
   * @response 200 {TeamsOk} Revoked
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found or invitation_unknown: the team has no such invitation
   */
  @Del(':team/invitations/:invitation')
  @Access('team:invitations.manage', { resource: TEAM })
  public async revoke(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() invitation: string) {
    return guarded(async () => {
      await this.Invitations.revoke(caller, team, invitation);
      return done();
    });
  }

  /**
   * Resend an invitation
   * Mails the email invitation again with a new token (the old one stops working) and sets `lastSentAt`. The answer does not carry the token.
   * @param team The team id
   * @param invitation The invitation id
   * @response 200 {TeamsInvitation} The invitation
   * @response 400 {TeamsError} invalid_request: the invitation has no email
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 Forbidden: no `team:invitations.manage` at the team
   * @response 404 {TeamsError} not_found or invitation_unknown: the team has no such invitation
   * @response 409 {TeamsError} invitation_expired, invitation_revoked or invitation_used_up
   */
  @Post(':team/invitations/:invitation/resend')
  @Access('team:invitations.manage', { resource: TEAM })
  public async resend(@CurrentPrincipal() caller: Principal, @Param() team: string, @Param() invitation: string) {
    return guarded(async () => {
      return new Ok(await this.Invitations.resend(caller, team, invitation));
    });
  }
}
```

Create `packages/teams-http/src/controllers/InvitationsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { CurrentPrincipal, IsAuthenticated } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import { InvitationService } from '@spinajs/teams';

import { NO_STORE } from '../http/answers.js';
import { guarded } from '../http/errors.js';
import { AcceptInvitationBody } from '../schemas/bodies.js';

/**
 * Accepting an invitation.
 * The route checks authentication only, as no permission names this action: the token is the authorisation. InvitationService checks expiry, revocation, uses and the invited email, and assigns the role (or adds the group member) as SYSTEM with reason `invitation:<id>`. A new user signs up first, through any login flow, then accepts with the token the client kept.
 * @tags Invitations
 */
@BasePath('invitations')
export class InvitationsController extends BaseController {
  @Autoinject(InvitationService)
  protected Invitations: InvitationService;

  /**
   * Accept an invitation
   * Joins the caller to the invitation's team or group. Accepting the same invitation again answers the same (idempotent). Sent with `Cache-Control: no-store`.
   * @response 200 {TeamsInvitationAccepted} The team, group and role the caller joined with
   * @response 400 Bad request: the body does not match AcceptInvitationBody
   * @response 401 Unauthorized: a valid session or token is required
   * @response 403 {TeamsError} invitation_email_mismatch (the caller's verified email is another, or none) or invitation_not_a_user
   * @response 404 {TeamsError} invitation_unknown: no invitation has this token (or a resend replaced it)
   * @response 409 {TeamsError} invitation_expired, invitation_revoked or invitation_used_up
   */
  @Post('accept')
  @Policy(IsAuthenticated)
  public async accept(@CurrentPrincipal() caller: Principal, @Body() body: AcceptInvitationBody) {
    return guarded(async () => new Ok(await this.Invitations.accept(caller, body.token), { Headers: [NO_STORE] }));
  }
}
```

In `src/controller-list.ts` import both and make the list `Object.freeze([TeamsController, TeamMembersController, TeamGroupsController, GroupsController, TeamInvitationsController, InvitationsController])`. Append to `src/index.ts`:

```ts
export * from './controllers/TeamInvitationsController.js';
export * from './controllers/InvitationsController.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `55 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): invitation routes and POST /invitations/accept"
```

---

### Task 6: `GET /user/teams` and the guard check over every route

**Files:**
- Create: `src/controllers/UserTeamsController.ts`, `test/user-teams.test.ts`, `test/routes.test.ts`
- Modify: `src/controller-list.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–5; L14 `TeamService.teamsOf`; authz-http `swaggerAccess`, `IsAuthenticated`; http `CONTROLLED_DESCRIPTOR_SYMBOL`, `IControllerDescriptor`.
- Produces: `UserTeamsController`; `TEAMS_HTTP_ROUTES: readonly string[]` (`'<METHOD> <path>'`, `:param` form) in `src/controller-list.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/teams-http/test/user-teams.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';

import { as, createGroup, grantAt, ownedTeam, send, teamRef, uniq } from './support/client.js';

describe('GET /user/teams', function () {
  this.timeout(30_000);

  it('is empty for a user in no team', async () => {
    const res = await as(uniq('nobody')).get('/user/teams');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ teams: [], groups: [] });
  });

  it("lists the caller's teams and groups with roles", async () => {
    const a = await ownedTeam();
    const b = await ownedTeam();
    const group = await createGroup(b.owner, b.team.id);
    const carol = uniq('carol');
    await grantAt(carol, 'team.admin', teamRef(a.team.id));
    expect((await as(b.owner).post(`/groups/${group.id}/members`, { subject: `user:${carol}` })).status).to.eq(200);

    const res = await as(carol).get('/user/teams');
    expect(res.status).to.eq(200);
    const team = res.body.teams.find((t: any) => t.id === a.team.id);
    expect(team).to.include({ id: a.team.id, slug: a.team.slug, name: a.team.name });
    expect(team.roles).to.include('team.admin');
    const member = res.body.groups.find((g: any) => g.id === group.id);
    expect(member).to.include({ id: group.id, teamId: b.team.id });
    expect(member.roles).to.include('group.member');
  });

  it('answers 401 without a principal', async () => {
    expect((await send('GET', '/user/teams')).status).to.eq(401);
  });
});
```

Create `packages/teams-http/test/routes.test.ts`:

```ts
import 'mocha';
import { expect } from 'chai';
import { IsAuthenticated, swaggerAccess } from '@spinajs/authz-http';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import { TEAMS_HTTP_CONTROLLERS, TEAMS_HTTP_ROUTES } from '../src/controller-list.js';

const AUTHENTICATED_ONLY = ['POST /invitations/accept', 'GET /user/teams'];

function routes() {
  return TEAMS_HTTP_CONTROLLERS.flatMap((controller) => {
    const d = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
    return [...d.Routes.entries()].map(([method, route]) => {
      const path = `/${d.BasePath}/${route.Path ?? ''}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      return { controller, method: method as string, route, key: `${String(route.Type).toUpperCase()} ${path}` };
    });
  });
}

describe('teams-http routes', () => {
  it('mounts exactly the routes of teams §9 and the restore route', () => {
    expect(routes().map((r) => r.key)).to.have.members([...TEAMS_HTTP_ROUTES]);
    expect(routes()).to.have.length(TEAMS_HTTP_ROUTES.length);
  });

  it('guards every route with @Access, except the two that check authentication only', () => {
    for (const r of routes()) {
      const access = swaggerAccess(r.controller, r.method);
      if (AUTHENTICATED_ONLY.includes(r.key)) {
        expect(access, r.key).to.eq(undefined);
        expect(r.route.Policies.some((group) => group.some((p) => p.Type === IsAuthenticated)), r.key).to.eq(true);
      } else {
        expect(access?.['x-authz-permission'], r.key).to.be.an('array').that.is.not.empty;
      }
    }
  });

  it('lets no route through anonymously', () => {
    for (const r of routes()) expect(swaggerAccess(r.controller, r.method)?.['x-authz-anonymous'], r.key).to.eq(undefined);
  });
});
```

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/user-teams.test.ts test/routes.test.ts`
Expected: FAIL: `routes.test.ts` does not compile (`TEAMS_HTTP_ROUTES` is not exported), and `GET /user/teams` answers 404.

- [ ] **Step 2: The controller and the route table**

Create `packages/teams-http/src/controllers/UserTeamsController.ts`:

```ts
import type { Principal } from '@spinajs/authz';
import { CurrentPrincipal, IsAuthenticated } from '@spinajs/authz-http';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { TeamService } from '@spinajs/teams';

import { guarded } from '../http/errors.js';

/**
 * The signed-in principal's teams.
 * The route checks authentication only, as authz-http's `/user/access` routes do: it answers about the caller and nothing else, and no permission names that.
 * @tags User teams
 */
@BasePath('user')
export class UserTeamsController extends BaseController {
  @Autoinject(TeamService)
  protected Teams: TeamService;

  /**
   * My teams and groups
   * The teams and groups where the caller holds a role, directly or through a group or team set, each with those roles. Empty for a caller in no team.
   * @response 200 {TeamsUserTeams} The caller's teams and groups
   * @response 401 Unauthorized: a valid session or token is required
   */
  @Get('teams')
  @Policy(IsAuthenticated)
  public async list(@CurrentPrincipal() caller: Principal) {
    return guarded(async () => new Ok(await this.Teams.teamsOf(caller)));
  }
}
```

Replace `packages/teams-http/src/controller-list.ts` with:

```ts
import type { Class } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';

import { GroupsController } from './controllers/GroupsController.js';
import { InvitationsController } from './controllers/InvitationsController.js';
import { TeamGroupsController } from './controllers/TeamGroupsController.js';
import { TeamInvitationsController } from './controllers/TeamInvitationsController.js';
import { TeamMembersController } from './controllers/TeamMembersController.js';
import { TeamsController } from './controllers/TeamsController.js';
import { UserTeamsController } from './controllers/UserTeamsController.js';

/** Every controller of the package, for apps and tests that mount controllers by hand instead of by `system.dirs.controllers`. */
export const TEAMS_HTTP_CONTROLLERS: readonly Class<BaseController>[] = Object.freeze([TeamsController, TeamMembersController, TeamGroupsController, GroupsController, TeamInvitationsController, InvitationsController, UserTeamsController]);

/** The routes of teams §9 plus the restore route, as `<METHOD> <path>`. */
export const TEAMS_HTTP_ROUTES: readonly string[] = Object.freeze([
  'GET /teams',
  'POST /teams',
  'GET /teams/:team',
  'PATCH /teams/:team',
  'DELETE /teams/:team',
  'POST /teams/:team/archive',
  'POST /teams/:team/unarchive',
  'POST /teams/:team/move',
  'POST /teams/:team/transfer',
  'POST /teams/:team/restore',
  'GET /teams/:team/members',
  'POST /teams/:team/members',
  'PATCH /teams/:team/members/:subject',
  'DELETE /teams/:team/members/:subject',
  'GET /teams/:team/groups',
  'POST /teams/:team/groups',
  'GET /groups/:group',
  'PATCH /groups/:group',
  'DELETE /groups/:group',
  'POST /groups/:group/move',
  'GET /groups/:group/members',
  'POST /groups/:group/members',
  'DELETE /groups/:group/members/:subject',
  'GET /teams/:team/invitations',
  'POST /teams/:team/invitations',
  'DELETE /teams/:team/invitations/:invitation',
  'POST /teams/:team/invitations/:invitation/resend',
  'POST /invitations/accept',
  'GET /user/teams',
]);
```

Append to `src/index.ts`:

```ts
export * from './controllers/UserTeamsController.js';
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `61 passing`.

- [ ] **Step 4: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): GET /user/teams; test that every route is guarded"
```

---

### Task 7: Swagger schemas

**Files:**
- Create: `src/schemas/responses.ts`, `src/schemas/provider.ts`, `src/schemas/index.ts`, `test/swagger.test.ts`
- Modify: the seven controllers (one import line each), `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–6; http-swagger `OpenApiBuilder`, `SwaggerDocCache`, `IOpenApiDocument`; validation `SchemaProvider`.
- Produces: answer schemas `TeamsTeam`, `TeamsTeamPage`, `TeamsGroup`, `TeamsGroupPage`, `TeamsMember`, `TeamsMemberPage`, `TeamsInvitation`, `TeamsInvitationPage`, `TeamsInvitationCreated`, `TeamsInvitationAccepted`, `TeamsUserTeams`, `TeamsOk`, `TeamsError`; `TEAMS_HTTP_SCHEMAS: Readonly<Record<string, JsonSchema>>`; `TeamsHttpSchemaProvider`.

- [ ] **Step 1: Write the failing test**

Create `packages/teams-http/test/swagger.test.ts`:

```ts
import 'mocha';
import { resolve } from 'node:path';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { OpenApiBuilder, SwaggerDocCache } from '@spinajs/http-swagger';
import type { IOpenApiDocument } from '@spinajs/http-swagger';

import { TEAMS_HTTP_CONTROLLERS, TEAMS_HTTP_ROUTES } from '../src/controller-list.js';
import { TEAMS_HTTP_SCHEMAS } from '../src/schemas/index.js';

// The controllers' JSDoc is read from the compiled files (`pretest` compiles them).
const compiled = (name: string) => resolve(process.cwd(), 'lib', 'mjs', 'controllers', `${name}.js`);
const openApiPath = (route: string) => route.slice(route.indexOf(' ') + 1).replace(/:(\w+)/g, '{$1}');
const verb = (route: string) => route.slice(0, route.indexOf(' ')).toLowerCase();
const AUTHENTICATED_ONLY = ['POST /invitations/accept', 'GET /user/teams'];

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

describe('teams-http swagger', function () {
  this.timeout(60_000);

  let doc: any;

  before(async () => {
    const listed = await (await DI.resolve(Controllers)).Controllers;
    const cache = await DI.resolve(SwaggerDocCache);
    const builder = await DI.resolve(OpenApiBuilder, [{ enabled: true, title: 'test', version: '1' }]);
    for (const c of TEAMS_HTTP_CONTROLLERS) {
      const info = listed.find((i) => i.name === c.name);
      expect(info, `${c.name} is registered`).to.not.eq(undefined);
      const entry = { ...info!, file: compiled(c.name) };
      builder.addController(entry, await cache.getCache(entry));
    }
    doc = builder.build() as IOpenApiDocument;
  });

  it("documents every route with a summary under its controller's tag", () => {
    const tags = ['Teams', 'Team members', 'Team groups', 'Groups', 'Team invitations', 'Invitations', 'User teams'];
    expect(doc.tags.map((t: any) => t.name)).to.include.members(tags);
    for (const route of TEAMS_HTTP_ROUTES) {
      const op = doc.paths[openApiPath(route)]?.[verb(route)];
      expect(op, route).to.not.eq(undefined);
      expect(op.summary, route).to.be.a('string').that.is.not.empty;
      expect(tags, route).to.include(op.tags[0]);
    }
  });

  it('carries the @Access permission on every guarded route and none on the authenticated-only ones', () => {
    for (const route of TEAMS_HTTP_ROUTES) {
      const op = doc.paths[openApiPath(route)][verb(route)];
      if (AUTHENTICATED_ONLY.includes(route)) expect(op['x-authz-permission'], route).to.eq(undefined);
      else expect(op['x-authz-permission'], route).to.be.an('array').that.is.not.empty;
    }
    const patch = doc.paths['/teams/{team}'].patch;
    expect(patch['x-authz-permission']).to.deep.eq(['team:update']);
    expect(patch['x-authz-resource']).to.deep.eq({ type: 'team', in: 'path', name: 'team' });
    expect(doc.paths['/teams/{team}/groups'].post['x-authz-permission']).to.deep.eq(['group:create']);
  });

  it('documents the request bodies from the @Schema classes', () => {
    const body = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema;
    expect(body('/teams', 'post').required).to.deep.eq(['slug', 'name']);
    expect(Object.keys(body('/teams', 'post').properties)).to.have.members(['slug', 'name', 'description', 'parentId']);
    expect(body('/teams/{team}/members', 'post').properties.subject.pattern).to.eq('^[^:]+:.+$');
    expect(body('/teams/{team}/invitations', 'post').required).to.deep.eq(['role']);
    expect(body('/groups/{group}/move', 'post').required).to.deep.eq(['parentId']);
    expect(body('/invitations/accept', 'post').required).to.deep.eq(['token']);
    expect(body('/teams/{team}/transfer', 'post').properties.keepAs).to.include({ type: 'string', nullable: true });
    expect(body('/teams/{team}', 'delete')).to.eq(undefined);
  });

  it('documents the query parameters', () => {
    const query = (path: string) => Object.fromEntries(doc.paths[path].get.parameters.filter((p: any) => p.in === 'query').map((p: any) => [p.name, p]));
    expect(Object.keys(query('/teams'))).to.have.members(['parentId', 'root', 'page', 'size']);
    for (const path of ['/teams/{team}/members', '/teams/{team}/groups', '/teams/{team}/invitations', '/groups/{group}/members']) {
      expect(Object.keys(query(path)), path).to.have.members(['page', 'size']);
      expect(query(path).size.schema, path).to.include({ minimum: 1, maximum: 200 });
    }
  });

  it('refers the answers to the Teams* components, and every $ref resolves', () => {
    const answer = (path: string, method: string, status = '200') => doc.paths[path][method].responses[status].content['application/json'].schema.$ref;
    expect(answer('/teams', 'get')).to.eq('#/components/schemas/TeamsTeamPage');
    expect(answer('/teams/{team}', 'get')).to.eq('#/components/schemas/TeamsTeam');
    expect(answer('/teams/{team}/members', 'get')).to.eq('#/components/schemas/TeamsMemberPage');
    expect(answer('/teams/{team}/invitations', 'post')).to.eq('#/components/schemas/TeamsInvitationCreated');
    expect(answer('/invitations/accept', 'post', '409')).to.eq('#/components/schemas/TeamsError');
    expect(answer('/user/teams', 'get')).to.eq('#/components/schemas/TeamsUserTeams');
    expect(doc.components.schemas.TeamsInvitation.properties).to.not.have.any.keys('token', 'tokenHash');
    for (const ref of refs(doc.paths)) {
      const [, , kind, name] = ref.split('/');
      expect(doc.components[kind], ref).to.have.property(name);
    }
    for (const name of Object.keys(TEAMS_HTTP_SCHEMAS)) expect(name).to.match(/^Teams[A-Z]/);
  });
});
```

Run: `cd packages/teams-http && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 60000 --file test/setup.ts --file test/hooks.ts test/swagger.test.ts`
Expected: FAIL, `Cannot find module '…/src/schemas/index.js'`.

- [ ] **Step 2: The answer schemas and the provider**

Create `packages/teams-http/src/schemas/responses.ts`:

```ts
export type JsonSchema = Record<string, unknown>;

const text: JsonSchema = { type: 'string' };
const nullableText: JsonSchema = { type: 'string', nullable: true };
const stamp: JsonSchema = { type: 'string', format: 'date-time', description: 'ISO 8601' };
const nullableStamp: JsonSchema = { ...stamp, nullable: true };
const roles: JsonSchema = { type: 'array', items: text };

function obj(required: readonly string[], properties: Record<string, JsonSchema>, description: string): JsonSchema {
  return { type: 'object', description, required: [...required], properties };
}

function page(item: JsonSchema, description: string): JsonSchema {
  return obj(['items', 'total'], { items: { type: 'array', items: item }, total: { type: 'integer', minimum: 0 } }, description);
}

function withRoles(view: JsonSchema, description: string): JsonSchema {
  return obj([...(view.required as string[]), 'roles'], { ...(view.properties as Record<string, JsonSchema>), roles }, description);
}

const TEAM_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  parentId: nullableText,
  slug: text,
  name: text,
  description: nullableText,
  archivedAt: nullableStamp,
  deletedAt: nullableStamp,
  createdBy: nullableText,
  createdAt: stamp,
  updatedAt: stamp,
};

export const TeamsTeam = obj(Object.keys(TEAM_PROPERTIES), TEAM_PROPERTIES, 'A team');

export const TeamsTeamPage = page(TeamsTeam, 'One page of teams; total counts all of them');

const GROUP_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  teamId: text,
  parentId: { ...nullableText, description: 'the outer group' },
  slug: text,
  name: text,
  description: nullableText,
  createdBy: nullableText,
  createdAt: stamp,
  updatedAt: stamp,
};

export const TeamsGroup = obj(Object.keys(GROUP_PROPERTIES), GROUP_PROPERTIES, 'A group of a team');

export const TeamsGroupPage = page(TeamsGroup, 'One page of groups; total counts all of them');

export const TeamsMember = obj(
  ['subject', 'role', 'assignmentId', 'expiresAt'],
  { subject: { ...text, description: '`group:<id>`, `team:<id>` or `<type>:<id>` of a principal' }, role: text, assignmentId: text, expiresAt: nullableStamp },
  'One assignment at a team or group',
);

export const TeamsMemberPage = page(TeamsMember, 'One page of members; total counts all of them');

const INVITATION_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  teamId: text,
  groupId: nullableText,
  role: text,
  email: { ...nullableText, description: 'null for a shareable link' },
  maxUses: { type: 'integer', nullable: true, description: 'null for unlimited until expiry' },
  uses: { type: 'integer', minimum: 0 },
  expiresAt: stamp,
  revokedAt: nullableStamp,
  createdBy: text,
  createdAt: stamp,
  lastSentAt: nullableStamp,
};

export const TeamsInvitation = obj(Object.keys(INVITATION_PROPERTIES), INVITATION_PROPERTIES, 'An invitation; never carries its token or the token hash');

export const TeamsInvitationPage = page(TeamsInvitation, 'One page of invitations; total counts all of them');

export const TeamsInvitationCreated = obj(['invitation', 'token'], { invitation: TeamsInvitation, token: { ...text, description: 'shown once, here; the client keeps it for POST /invitations/accept' } }, 'A new invitation and its token');

export const TeamsInvitationAccepted = obj(['invitationId', 'teamId', 'groupId', 'role'], { invitationId: text, teamId: text, groupId: nullableText, role: text }, 'What the caller joined');

export const TeamsUserTeams = obj(
  ['teams', 'groups'],
  {
    teams: { type: 'array', items: withRoles(TeamsTeam, "A team of the caller with the caller's roles there") },
    groups: { type: 'array', items: withRoles(TeamsGroup, "A group of the caller with the caller's roles there") },
  },
  "The caller's teams and groups",
);

export const TeamsOk = obj(['ok'], { ok: { type: 'boolean', enum: [true] } }, 'Done');

export const TeamsError = obj(
  ['error'],
  { error: obj(['code', 'message'], { code: text, message: text, field: { ...text, description: 'the input the error is about' } }, 'The refusal') },
  "A refused request. Codes: 400 invalid_request and the AuthzAdmin validation codes (unknown_role, wrong_scope_type, not_assignable, set_cycle, set_too_deep, …); 403 forbidden, escalation, last_holder, self_lockout, protected_role, invitation_email_mismatch, invitation_not_a_user; 404 not_found, invitation_unknown; 409 conflict, invitation_expired, invitation_revoked, invitation_used_up. A refusal of the route check itself answers authz-http's `{ error: 'forbidden', permission, resource, reason }`.",
);
```

Create `packages/teams-http/src/schemas/provider.ts`:

```ts
import { Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

import * as responses from './responses.js';
import type { JsonSchema } from './responses.js';

/** Every answer schema by the name the controllers' `@response` tags use. */
export const TEAMS_HTTP_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze(Object.fromEntries(Object.entries(responses).filter(([name]) => name.startsWith('Teams')) as [string, JsonSchema][]));

/** Serves the answer schemas to http-swagger; request bodies are `@Schema` classes and need no provider. */
@Injectable(SchemaProvider)
export class TeamsHttpSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return Object.hasOwn(TEAMS_HTTP_SCHEMAS, typeName) ? TEAMS_HTTP_SCHEMAS[typeName] : undefined;
  }
}
```

Create `packages/teams-http/src/schemas/index.ts`:

```ts
export * from './bodies.js';
export * from './responses.js';
export * from './provider.js';
```

In each of the seven files in `src/controllers/`, add below the `@spinajs/teams` import:

```ts
import '../schemas/provider.js';
```

In `packages/teams-http/src/index.ts` replace `export * from './schemas/bodies.js';` with:

```ts
export * from './schemas/index.js';
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/teams-http && npm test`
Expected: `66 passing`.

- [ ] **Step 4: Commit**

```bash
git add packages/teams-http
git commit -m "feat(teams-http): swagger answer schemas and their provider"
```

---

### Task 8: README, alignment with L14, lane verification

**Files:**
- Create: `packages/teams-http/README.md`
- Modify: whatever the alignment step finds

**Interfaces:**
- Consumes: everything above; the merged `packages/teams/src/api.ts`, `src/config/teams.ts`, `test/support/stack.ts`.
- Produces: the package README.

- [ ] **Step 1: Align with the merged L14**

Compare the "Interfaces consumed from L14" table with the merged `packages/teams/src/api.ts` (any change since L14 Task 1 comes with an RFC `docs/plans/authz-v3-rfc/RA14-*.md`). Fix a difference here, in the one place it is used:

| L14 differs in | Change here |
|---|---|
| a service method name or argument | the call in the controller that uses it |
| a view field | `src/schemas/responses.ts` and the test that reads it |
| an `InvitationRefusal` code | the code sets in `src/http/errors.ts`, `TeamsError`'s description, the README error table, the tests |
| a list's paging argument (position, or `opts.page`) | the call in that route's controller |
| a revoke/resend argument order | `TeamInvitationsController.revoke` / `resend` |
| registrations in `test/support/stack.ts` | mirror them in `startTeamsApp` |

Run: `cd packages/teams && npm run compile && cd ../teams-http && npm test`
Expected: `66 passing`.

- [ ] **Step 2: Write the README**

Create `packages/teams-http/README.md`:

````markdown
# `@spinajs/teams-http`

REST API over `@spinajs/teams` (teams, groups, members, invitations). Every route calls
`TeamService`, `GroupService` or `InvitationService` with the request principal as the actor; the
services are the authority, the routes add the HTTP surface.

## Routes

| Route | Access | Service |
|---|---|---|
| `GET /teams?parentId=&root=&page=&size=` | `team:read` (type level) | `listTeams` (`.accessible('team:read')`) |
| `POST /teams` `{ slug, name, description?, parentId? }` | `team:create` (type level; exact scope in the service) | `createTeam` |
| `GET` / `PATCH` / `DELETE /teams/:team` | `team:read` / `team:update` / `team:delete` at the team | `getTeam` / `updateTeam` / `deleteTeam` (soft) |
| `POST /teams/:team/restore` | `team:delete` | `restoreTeam` |
| `POST /teams/:team/archive`, `…/unarchive` | `team:archive` | `archiveTeam` / `unarchiveTeam` |
| `POST /teams/:team/move` `{ parentId }` | `team:update` (+ `team:create` at the new parent, in the service) | `moveTeam` |
| `POST /teams/:team/transfer` `{ to: 'user:<id>', keepAs? }` (the caller keeps `keepAs`, default `team.admin`; `null`: nothing) | `team:ownership.transfer` | `transferOwnership` |
| `GET /teams/:team/members?page=&size=` | `team:read` | `members` |
| `POST /teams/:team/members` `{ subject, role? }` | `team:members.manage` | `addTeamMember` |
| `PATCH /teams/:team/members/:subject` `{ role }` | `team:roles.manage` | `setTeamRole` |
| `DELETE /teams/:team/members/:subject` | `team:members.manage` | `removeTeamMember` |
| `GET /teams/:team/groups?page=&size=` | `team:read` | `listGroups` (`.accessible('group:read').within(team)`) |
| `POST /teams/:team/groups` `{ slug, name, description?, parentId? }` | `group:create` at the team | `createGroup` |
| `GET` / `PATCH` / `DELETE /groups/:group` | `group:read` / `group:update` / `group:delete` | `getGroup` / `updateGroup` / `deleteGroup` |
| `POST /groups/:group/move` `{ teamId?, parentId }` | `group:update` | `moveGroup` |
| `GET /groups/:group/members?page=&size=` | `group:read` | `members` |
| `POST /groups/:group/members` `{ subject }`, `DELETE /groups/:group/members/:subject` | `group:members.manage` | `addGroupMember` / `removeGroupMember` |
| `GET /teams/:team/invitations?page=&size=` | `team:invitations.manage` | `InvitationService.list` |
| `POST /teams/:team/invitations` `{ groupId?, role, email?, maxUses?, expiresInHours? }` | `team:invitations.manage` | `InvitationService.create` |
| `DELETE /teams/:team/invitations/:invitation`, `POST …/:invitation/resend` | `team:invitations.manage` | `revoke` / `resend` |
| `POST /invitations/accept` `{ token }` | authenticated | `InvitationService.accept` |
| `GET /user/teams` | authenticated | `TeamService.teamsOf` |

- Subjects are `user:<id>`, `group:<id>` or `team:<id>` (any `<type>:<id>` names a principal), in
  bodies and (URL-encoded) in paths.
- Every list is paged: `page` from 0 (default 0), `size` 1 to 200 (default 50); the answer is
  `{ items, total }`, `total` counting every row the caller may see.
- Granting a role to a whole team or group on another team's resource (cross-team sharing) has no
  route here: use `@spinajs/authz-http-admin`'s `POST /authz/assignments` (subject
  `{ set: { role: 'team.member', scope: { type: 'team', id } } }` or `group.member` at the group) and
  `DELETE /authz/assignments/:id`. The teams fragment maps those commands at team and group scopes to
  the teams permissions, so team admins need no `authz:*` permission. `TeamService.grant` / `revoke`
  are the same for in-process callers.
- Writes on a team, group or invitation answer it; membership changes, deletes and revocations answer
  `{ ok: true }`. Dates are ISO 8601 strings.

## Access

- The route's `@Access` checks at the team or group in the path, or at type level for `GET /teams` and
  `POST /teams`; the service checks the exact scope again (a root team needs `team:create` at
  `$global`, a sub-team at its parent). A caller who can read no team gets 403 from `GET /teams`:
  `GET /user/teams` is "my teams" for everyone.
- `POST /invitations/accept` and `GET /user/teams` check authentication only: the token is the
  authorisation of the first, the second answers about the caller only. No route allows anonymous
  callers.
- Lists are filtered in SQL by the services (`.accessible()`, `.within()` of `@spinajs/authz-orm`).

## Errors

A refused service call answers `{ error: { code, message, field? } }`:

| Status | Codes |
|---|---|
| 400 | `invalid_request` and the AuthzAdmin validation codes (`unknown_role`, `wrong_scope_type`, `not_assignable`, `set_cycle`, `set_too_deep`, …) |
| 403 | `forbidden`, `escalation`, `last_holder`, `self_lockout`, `protected_role`, `invitation_email_mismatch`, `invitation_not_a_user` |
| 404 | `not_found`, `invitation_unknown` |
| 409 | `conflict`, `invitation_expired`, `invitation_revoked`, `invitation_used_up` |

The AuthzAdmin codes answer as on `@spinajs/authz-http-admin`. A body or query parameter that does
not match its schema answers http's validation 400; a refusal of the route's `@Access` answers
authz-http's 403 `{ error: 'forbidden', permission, resource, reason }`.

## Invitations

The token is in the answer of `POST /teams/:team/invitations` (sent with `Cache-Control: no-store`)
or in the invitation mail, nowhere else; lists and resends never carry it or its hash. A resend mails
a new token and the old one stops working. A new user signs up through any login flow, then calls
`POST /invitations/accept` with the token the client kept; an email invitation opens only for a
principal whose verified email (`VerifiedEmailSource`) is the invited one.

## Setup

- Install the package: its config fragment adds `lib/<mjs|cjs>/controllers` to
  `system.dirs.controllers`. An app that mounts controllers by hand registers
  `TEAMS_HTTP_CONTROLLERS`.
- `@spinajs/teams` brings the roles, permissions, migrations, guard rules and the archived policies;
  the app wires RBAC (`registerRbac`), an ABAC model over `authz.abac.policies`, a scope attribute
  store and the admin backend as for any authz app, registers a `VerifiedEmailSource` (email
  invitations fail without one), gives some role `team:create` at `$global`, and sets
  `teams.invitations.secret`.

## Swagger

http-swagger documents every route: the `@Access` permission (`x-authz-*`), the request bodies (the
`@Schema` DTO classes), the query parameters and the answers (`Teams*` schemas served by
`TeamsHttpSchemaProvider`).
````

- [ ] **Step 3: Lane verification**

Run (repo root): `npm run build 2>&1 | grep -c "error TS"`
Expected: `0`.

Run (repo root): `node scripts/api-snapshot.mjs --check`
Expected: `API snapshots are up to date` (teams-http has no snapshot; nothing else changed).

Run: `cd packages/teams-http && npm test`
Expected: `66 passing`, no failing.

Run (repo root): `grep -rn "AllowAnonymous" packages/teams-http/src; grep -rnE "import type \{[^}]*Body[ ,}]" packages/teams-http/src/controllers`
Expected: no output (no anonymous route; DTOs imported as values).

- [ ] **Step 4: Commit**

```bash
git add packages/teams-http
git commit -m "docs(teams-http): README; align with L14"
```

---

## Contract issues found

Raised while planning; the coordinator's resolutions are recorded here and applied above.

1. **Paging on every list.** L14 Task 1 returned whole arrays from `listTeams`, `listGroups` and `InvitationService.list`. *Resolved:* L14 adds a `Page` argument and `Paged<T>` answers; L15 takes `page` / `size` on every list route (Decision 7). The exact parameter position is re-checked in Task 8 Step 1.
2. **`revoke` / `resend` without a team.** *Resolved:* L14 adds `teamId`; L15 passes the path's team and does no lookup of its own (Decision 8).
3. **Two routes not on `@Access`** (teams §9 says every route): `POST /invitations/accept` (authorised by the token) and `GET /user/teams` (about the caller only) use `@Policy(IsAuthenticated)`, as authz-http's `/user/access/*`. *Accepted;* `test/routes.test.ts` pins exactly these two.
4. **`group:create` is checked at a team ref.** *Resolved:* L14's fragment declares `team` among its types.
5. **`InvitationRefused` is a `Forbidden` for every code.** *Resolved:* L14 keeps a stable `code`; L15 answers `invitation_<code>` with 404 / 409 / 403 by code (Decision 3).
6. **`GET /teams` answers 403, not an empty list, to a caller who can read no team** (a type-level `team:read` check without any grant is a denial). Accepted and documented; `GET /user/teams` is "my teams" for everyone.
7. **L14 operations without a §9 route.** *Resolved:* `POST /teams/:team/restore` (`team:delete`) is added; cross-team grants stay on authz-http-admin's generic assignment routes (README); `purgeTeam` / `purgeDue` stay scheduler and CLI operations.
8. **Test stack.** L15 boots its own app (users-http pattern: package defaults, migrations on startup) rather than importing L14's `test/support/stack.ts` (built for service tests without HTTP), and mirrors that stack's root registrations (scope attribute store, ABAC model, `registerRbac`, mailer, email source). A registration L14 adds later must be mirrored in `startTeamsApp` (Task 8 Step 1).
