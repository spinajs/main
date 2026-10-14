# Lane L6: rbac storage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first (Global Constraints apply to every task).

**Goal:** Give `authz_assignment` a one-column subject key, materialize the transitive closure of subject sets in `authz_subject_membership` (design §4.2, §4.3), keep it right inside every `AuthzAdmin` batch, and ship `authz:membership-verify` / `authz:membership-rebuild`.

**Architecture:** `subjectKeyOf` (stores/columns.ts) is the key format every lane shares. A pure function, `computeClosures` (src/membership/closure.ts), walks live set-membership edges level by level for many members at once and returns closure rows (shortest depth; expiry = latest over paths of the earliest edge on the path). The RBAC write handlers and `RbacScopeForgetter` call `refreshMemberships` after they change assignment rows: it recomputes the touched members and every member below them, refuses cycles and over-deep nesting before writing, replaces their rows through the `AdminMembershipStore` port, and returns precise cache tags. `DbMembershipStore` and `MemoryMembershipStore` implement the port and the frozen `MembershipStore` contract.

**Tech Stack:** TypeScript, `@spinajs/orm` (SQLite, PostgreSQL in tests), mocha/chai, `@spinajs/cli`.

**Depends on:** G0 (`MembershipStore`, `SubjectKey` in `packages/authz-rbac/src/contracts.ts`, delivered by L0) and L7 merged (both lanes edit `AuthzRbac_2026_10_01_00_00_00` and the stores).

**Blocks:** L8 tasks that read membership (`MembershipStore.setsOf` for plans and checks, `membersOf` for `ChangeAudience`).

**Serves the teams lanes:** Task 7 (set-in-set membership: team ⊃ group ⊃ group ⊃ user, sub-teams, membership through roles that extend a set role, moving a group between teams) locks the closure behaviour the teams lanes L14/L15 build on (`docs/plans/2026-10-14-teams-design.md` §3, §10).

## Global Constraints

- English everywhere; comments only where a reader would ask "why?".
- 3.0 is unreleased: `AuthzRbac_2026_10_01_00_00_00` and `AuthzRbacUserRoles_2026_10_01_00_01_00` are edited in place.
- Do not edit `packages/authz-rbac/src/contracts.ts` (L0 owns it). `src/stores/schema.ts` is also edited by L8 (`maxPlanSubjects`): rebase, do not overwrite.
- Every task ends with `cd packages/authz-rbac && npm test` green (Postgres suites skip without the server on `127.0.0.1:15432`; run them when it is up).
- Commit after each task.

## Decisions taken in this lane

- **Key widths stay at 200** (design §4.2/§4.3). A set key can reach 64 + 1 + 64 + 1 + 128 characters; `DbAssignmentStore.assign` refuses a subject whose key is longer than 200 (`invalid_command`, field `subject`). 200 + 200 keeps the membership primary key under MSSQL's 900-byte clustered key limit.
- **Change tags of membership writes** are `subject:<setKey>` and `subject:<memberKey>` (so `RbacChangeAudience` can resolve set keys through `membersOf`), never `role:<setRole>` when a closure table exists. Invalidation still holds (verified in source): the decision cache indexes `subject:` tags as they are (`packages/authz/src/engine/cache-key.ts:375`), and `AssignmentCache.invalidate` drops every set entry on any `subject:` tag (`packages/authz-rbac/src/model/cache.ts:130-131`), so a set key tag drops the set's cached rows; members' cached decisions drop through their own `subject:` tags, or through `*` past MEMBERSHIP_TAG_LIMIT. Without a closure table a set grant keeps `role:<setRole>`.
- **Maintenance runs in the write handlers**, inside the batch transaction, not in `DbAuthzAdminBackend` (design §4.3 says backend): the backend knows no stores, and the handlers already hold the rows they changed. It runs only when the domain registers an `AdminMembershipStore`.
- **Depth semantics:** `depth` is the shortest path. A write that leaves any set more than `authz.rbac.maxSetDepth` levels above a member is refused with the new code `set_too_deep`; a set reaching itself is `set_cycle`.
- **Default store:** `authz.rbac.stores.membership` defaults to `['DbMembershipStore']` only when the assignment store is `DbAssignmentStore` (the closure is derived from those rows); otherwise it defaults to none.
- **Key escaping (coordinator decision):** the id part of every key escapes `%`→`%25`, `#`→`%23`, `*`→`%2A`; the type part keeps the core `principalKey` escaping (`%`, `:`); the wildcard id `*` is written literally (`user:*`). Keys are therefore unambiguous. For a principal id containing `%`, `#` or `*` the key differs from the core `principalKey`, so L8 must build subject keys with `subjectKeyOf`, never with `principalKey`.

## Files

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/authz-rbac/src/migrations/AuthzRbac_2026_10_01_00_00_00.ts` | `subject_key` + index; `authz_subject_membership` |
| Modify | `packages/authz-rbac/src/migrations/AuthzRbacUserRoles_2026_10_01_00_01_00.ts:141-153` | writes `subject_key` |
| Modify | `packages/authz-rbac/src/stores/columns.ts` | `subjectKeyOf`, `SUBJECT_KEY_MAX_LENGTH` |
| Modify | `packages/authz-rbac/src/stores/assignment-row.ts` | `AssignmentRow.subject_key` |
| Modify | `packages/authz-rbac/src/stores/db-assignment-store.ts` | key writes, key reads, `forSubjectKeys` |
| Create | `packages/authz-rbac/src/membership/closure.ts`, `src/membership/maintenance.ts`, `src/membership/index.ts` | closure algorithm; verify/rebuild |
| Create | `packages/authz-rbac/src/stores/db-membership-store.ts` | `DbMembershipStore`, `AUTHZ_SUBJECT_MEMBERSHIP_TABLE` |
| Create | `packages/authz-rbac/src/admin/memory/membership-store.ts` | `MemoryMembershipStore` |
| Create | `packages/authz-rbac/src/admin/membership.ts` | `refreshMemberships`, `subjectTags`, `membershipEdges` |
| Modify | `packages/authz-rbac/src/admin/ports.ts:26,22-28` | `forSubjectKeys`, `AdminMembershipStore`, forgetScope doc |
| Modify | `packages/authz-rbac/src/admin/memory/assignment-store.ts:58-61,102-107` | `forSubjectKeys`; forgetScope like the DB store |
| Modify | `packages/authz-rbac/src/admin/assignments.ts:82-141`, `src/admin/links.ts:40-66`, `src/admin/forgetter.ts` | call `refreshMemberships` |
| Modify | `packages/authz-rbac/src/admin/common.ts:55-76` | `loadRoleIndex(container, where)` |
| Modify | `packages/authz-rbac/src/stores/defaults.ts`, `src/stores/register.ts:11-16`, `src/host/register.ts:59-62`, `src/stores/schema.ts:155,170` | store kind `membership`; `maxSetDepth` |
| Create | `packages/authz-rbac/src/cli/commands/membership.ts` | the two CLI commands |
| Modify | `src/index.ts`, `src/stores/index.ts`, `src/admin/index.ts`, `src/admin/memory/index.ts`, `src/cli/index.ts` | exports |
| Tests | `test/stores/subject-key.test.ts` (new), `test/membership/closure.test.ts` (new), `test/membership/stores.test.ts` (new), `test/admin/membership.test.ts` (new), `test/cli/membership.test.ts` (new), `test/admin/membership-teams.test.ts` (new, Task 7), `test/stores/db-assignment-store.test.ts`, `test/migrations/*.test.ts`, `test/integration/db-harness.ts`, `test/admin/memory-stores.test.ts` | |
| Modify | `packages/users/test/migration/rbac.migration.ts:13-18`, `packages/users/test/role-assignments.test.ts:62-67` | raw inserts write `subject_key` |

---

### Task 1: `subject_key` on `authz_assignment`

**Files:**
- Modify: `src/stores/columns.ts`, `src/stores/assignment-row.ts`, `src/stores/db-assignment-store.ts`, `src/admin/ports.ts`, `src/admin/memory/assignment-store.ts`, `src/migrations/AuthzRbac_2026_10_01_00_00_00.ts`, `src/migrations/AuthzRbacUserRoles_2026_10_01_00_01_00.ts`
- Test: `test/stores/subject-key.test.ts` (new), `test/stores/db-assignment-store.test.ts`, `test/migrations/authz-rbac-initial.test.ts`, `test/migrations/user-roles-copy.test.ts`, `test/migrations/user-role-drop.test.ts`, `test/integration/db-harness.ts`
- Modify: `packages/users/test/migration/rbac.migration.ts`, `packages/users/test/role-assignments.test.ts`

**Interfaces:**
- Consumes: `SubjectKey` (L0, `src/contracts.ts`), `principalKey` (core).
- Produces: `subjectKeyOf(subject: AssignmentSubject): SubjectKey` and `SUBJECT_KEY_MAX_LENGTH = 200` (`src/stores/columns.ts`); `AdminAssignmentStore.forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]>` (live rows whose `subjectKeyOf(subject)` is one of `keys`), implemented by `DbAssignmentStore` and `MemoryAdminAssignmentStore`.

- [ ] **Step 1: Write the failing tests**

Create `test/stores/subject-key.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import { GLOBAL } from '@spinajs/authz';

import { subjectKeyOf } from '../../src/index.js';

describe('subjectKeyOf', () => {
  it('is the core principal key for a principal, `type:*` for a wildcard', () => {
    expect(subjectKeyOf({ type: 'user', id: '42' })).to.eq('user:42');
    expect(subjectKeyOf({ type: 'user', id: '*' })).to.eq('user:*');
    expect(subjectKeyOf({ type: 'a:b%', id: '1' })).to.eq('a%3Ab%25:1');
  });

  it('is `type:id#role` for a subject set, GLOBAL and type-level scopes with an empty id', () => {
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: '7' } } })).to.eq('team:7#member');
    expect(subjectKeyOf({ set: { role: 'admins', scope: GLOBAL } })).to.eq('$global:#admins');
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team' } } })).to.eq('team:#member');
  });

  it('escapes %, # and * in the id of a principal, so no principal key equals a set key or the wildcard', () => {
    expect(subjectKeyOf({ type: 'team', id: '7#member' })).to.eq('team:7%23member');
    expect(subjectKeyOf({ type: 'user', id: 'a*' })).to.eq('user:a%2A');
    expect(subjectKeyOf({ type: 'user', id: '**' })).to.eq('user:%2A%2A');
    expect(subjectKeyOf({ type: 'user', id: '50%' })).to.eq('user:50%25');
    expect(subjectKeyOf({ type: 'user', id: '%23' })).to.eq('user:%2523');
  });

  it('escapes %, # and * in the id of a set scope; the role follows the first #', () => {
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: 'a#b' } } })).to.eq('team:a%23b#member');
    expect(subjectKeyOf({ set: { role: 'member', scope: { type: 'team', id: '*' } } })).to.eq('team:%2A#member');
    expect(subjectKeyOf({ set: { role: 'm#x', scope: { type: 'team', id: '1%' } } })).to.eq('team:1%25#m#x');
  });
});
```

In `test/stores/db-assignment-store.test.ts`:

1. Import `AuthzAdminFailure` (already imported) and add `subjectFromColumns, subjectKeyOf` to the `../../src/index.js` import.
2. Replace the `row` helper (line 45) with

```ts
const row = (over: Row = {}): Row => {
  const r = { id: 'a1', subject_type: 'user', subject_id: 'alice', subject_role: '', role: 'editor', scope_type: 'project', scope_id: 'p1', tags: '', expires_at: null, granted_by: null, source: 'db', created_at: CREATED, ...over };
  return { subject_key: subjectKeyOf(subjectFromColumns(String(r.subject_type), String(r.subject_id), String(r.subject_role))), ...r };
};
```

3. Add inside `describe(\`DbAssignmentStore (${kind})\`, …)`:

```ts
    describe('subject_key', () => {
      it('assign writes the key of a principal, a set and a wildcard', async () => {
        await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1 }, root, tx));
        await inTx((tx) => store.assign({ subject: o1Members, role: 'editor', scope: P1 }, root, tx));
        await inTx((tx) => store.assign({ subject: { type: 'user', id: '*' }, role: 'viewer', scope: P1 }, root, tx));
        const keys = ((await db.driver.select().from('authz_assignment').columns(['subject_key'])) as Row[]).map((r) => String(r.subject_key)).sort();
        expect(keys).to.deep.eq(['org:o1#org.member', 'user:*', 'user:alice']);
      });

      it('a principal id holding # or * gets its own key, apart from the set and the wildcard', async () => {
        const odd: PrincipalRef = { type: 'org', id: 'o1#org.member' };
        const star: PrincipalRef = { type: 'user', id: '*x' };
        await inTx((tx) => store.assign({ subject: odd, role: 'editor', scope: P1 }, root, tx));
        await inTx((tx) => store.assign({ subject: o1Members, role: 'viewer', scope: P1 }, root, tx));
        await inTx((tx) => store.assign({ subject: star, role: 'editor', scope: P1 }, root, tx));
        expect((await store.forSubjects([o1Members], AT)).map((a) => a.role)).to.deep.eq(['viewer']);
        expect((await store.forSubjects([odd], AT)).map((a) => a.role)).to.deep.eq(['editor']);
        expect((await store.forSubjectKeys(['org:o1#org.member'], AT)).map((a) => a.role)).to.deep.eq(['viewer']);
        expect((await store.forSubjectKeys(['org:o1%23org.member'], AT)).map((a) => a.role)).to.deep.eq(['editor']);
        expect(await store.forSubjectKeys(['user:*'], AT)).to.deep.eq([]);
        expect((await store.forSubjectKeys(['user:%2Ax'], AT)).map((a) => a.subject)).to.deep.eq([star]);
      });

      it('forSubjectKeys skips expired rows', async () => {
        await inTx((tx) => store.assign({ subject: alice, role: 'editor', scope: P1, expiresAt: BEFORE }, root, tx));
        expect(await store.forSubjectKeys(['user:alice'], AT)).to.deep.eq([]);
      });

      it('refuses a subject whose key is longer than 200 characters (invalid_command)', async () => {
        const long = { set: { role: 'r'.repeat(128), scope: { type: 't'.repeat(64), id: 'i'.repeat(64) } } };
        await expect(inTx((tx) => store.assign({ subject: long, role: 'editor', scope: P1 }, root, tx)))
          .to.be.rejectedWith(AuthzAdminFailure)
          .and.eventually.include({ code: 'invalid_command', field: 'subject' });
      });
    });
```

In `test/migrations/authz-rbac-initial.test.ts`: in `SCHEMA.authz_assignment` insert `['subject_key', 'string', 200, false],` right after the `subject_role` entry; in `'creates the §9.1 indexes'` add

```ts
      expect(await find('authz_assignment', 'authz_assignment_subject')).to.deep.eq({ name: 'authz_assignment_subject', unique: false, columns: ['subject_key', 'role'] });
```

and replace the `assignment` helper (line 159) with

```ts
const assignment = (over: Record<string, unknown> = {}) => {
  const r = { id: 'a1', subject_type: 'user', subject_id: 'u1', subject_role: '', role: 'editor', created_at: NOW, ...over };
  return { subject_key: r.subject_role ? `${r.subject_type}:${r.subject_id}#${r.subject_role}` : `${r.subject_type}:${r.subject_id}`, ...r };
};
```

and add

```ts
    it('authz_assignment refuses a row without subject_key', async () => {
      const { subject_key: _key, ...rest } = assignment({ id: 'nk-1' });
      await expect(insert(db.driver, 'authz_assignment', rest)).to.be.rejected;
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/authz-rbac && npm test`
Expected: compile FAILS: `Module '"../../src/index.js"' has no exported member 'subjectKeyOf'` (and `forSubjectKeys` does not exist on `DbAssignmentStore`).

- [ ] **Step 3: `subjectKeyOf`**

In `src/stores/columns.ts` change line 1 to `import { AuthzConfigError, GLOBAL, principalKey } from '@spinajs/authz';`, add `import type { SubjectKey } from '../contracts.js';`, and append:

```ts
/** `authz_assignment.subject_key` and the keys of `authz_subject_membership` hold this many characters. */
export const SUBJECT_KEY_MAX_LENGTH = 200;

// '%' first, so an escape is never escaped again.
const escapeKeyId = (id: string): string => id.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\*/g, '%2A');

/**
 * The one-column key of a subject (design §4.2): `type:id` for a principal (`user:*` for the wildcard subject),
 * `type:id#role` for a subject set. The type is escaped as the core `principalKey` does; the id escapes `%`, `#`
 * and `*`, so the first `#` after the `:` starts the role and no principal key equals a set key or a wildcard.
 */
export function subjectKeyOf(subject: AssignmentSubject): SubjectKey {
  if ('set' in subject) {
    const c = subjectToColumns(subject);
    // A set at node '*' is a set like any other, not a wildcard.
    return `${principalKey({ type: c.subject_type, id: escapeKeyId(c.subject_id) })}#${c.subject_role}`;
  }
  // The bare id '*' is the wildcard subject (design §4.2) and stays literal.
  return principalKey({ type: subject.type, id: subject.id === '*' ? '*' : escapeKeyId(subject.id) });
}
```

- [ ] **Step 4: Migration, row type, user-roles copy**

`src/migrations/AuthzRbac_2026_10_01_00_00_00.ts`: after `table.string('subject_role', 128)…` add

```ts
      // One portable key column: a row-value IN over (type, id, role) does not work on MSSQL or older SQLite.
      table.string('subject_key', 200).notNull();
```

and after the `authz_assignment_expires` index add

```ts
    await connection.index().table('authz_assignment').name('authz_assignment_subject').columns(['subject_key', 'role']);
```

`src/stores/assignment-row.ts`: add `subject_key: string;` after `subject_role` in `AssignmentRow`.

`src/migrations/AuthzRbacUserRoles_2026_10_01_00_01_00.ts`: import `subjectKeyOf` with `scopeToColumns, subjectToColumns` from `../stores/columns.js`; in `assignmentsOf` add `subject_key: subjectKeyOf({ type: 'user', id }),` after `...subject,`; the comment on `insertBatch` (line 30) becomes `/** 11 columns a row keep one insert under SQLite's 999 bound parameters. */`.

- [ ] **Step 5: `DbAssignmentStore`**

In `src/stores/db-assignment-store.ts`:

1. Line 12-13 imports become

```ts
import { SUBJECT_KEY_MAX_LENGTH, scopeToColumns, subjectKeyOf, subjectToColumns } from './columns.js';
import type { SubjectColumns } from './columns.js';
```

2. Line 38 comment becomes `// One bound parameter per subject key: far below SQLite's 999.`

3. Replace `forSubjects` (lines 62-78) with

```ts
  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    if (subjects.length === 0) return [];
    return (await this.rowsForKeys(subjects.map(subjectKeyOf), at)).map(rowToAssignment);
  }

  async forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]> {
    return (await this.rowsForKeys(keys, at)).map(rowToAssignment);
  }
```

4. In `assign` (lines 94-117) after `const key = …` add

```ts
    const subjectKey = subjectKeyOf(a.subject);
    if (subjectKey.length > SUBJECT_KEY_MAX_LENGTH) {
      throw new AuthzAdminFailure('invalid_command', `${this.name}.assign: the subject key ${JSON.stringify(subjectKey.slice(0, 40))}… is longer than ${SUBJECT_KEY_MAX_LENGTH} characters`, 'subject');
    }
```

and change the insert row to `row = { id: randomUUID(), ...key, subject_key: subjectKey, ...change, source: 'db', created_at: this.now() };`.

5. Replace the body of `revokeSubjects` (lines 183-195) with

```ts
  async revokeSubjects(subjects: readonly AssignmentSubject[], tx: AuthzTx): Promise<readonly Assignment[]> {
    const driver = await this.writeDriver(tx, `${this.name}.revokeSubjects`);
    return this.deleteRows(driver, await this.rowsForKeys(subjects.map(subjectKeyOf), undefined));
  }
```

6. Add the private reader next to `select`:

```ts
  /** Rows of these subject keys, in batches; `at` undefined keeps expired rows. */
  private async rowsForKeys(keys: readonly string[], at: Date | undefined): Promise<AssignmentRow[]> {
    const unique = [...new Set(keys)];
    const driver = await this.connection();
    const out: AssignmentRow[] = [];
    for (let i = 0; i < unique.length; i += this.subjectBatch) {
      const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE).whereIn('subject_key', unique.slice(i, i + this.subjectBatch));
      if (at) whereLive(query, at);
      out.push(...(await rowsOf(query)));
    }
    return out;
  }
```

7. Delete `uniqueSubjects` and `whereSubjects` (lines 325-351), and drop the now unused `SubjectColumns` type import.

- [ ] **Step 6: Port and memory store**

`src/admin/ports.ts`, in `AdminAssignmentStore` after `find`:

```ts
  /** Live rows whose subject has one of these keys (subjectKeyOf): how the membership closure walks up. */
  abstract forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]>;
```

`src/admin/memory/assignment-store.ts`: import `subjectKeyOf` from `'../../stores/columns.js'` and add after `forSubjects`:

```ts
  async forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]> {
    const wanted = new Set(keys);
    return [...this.rows.values()].filter((a) => wanted.has(subjectKeyOf(a.subject)) && isLive(a.expiresAt, at)).map(copy);
  }
```

- [ ] **Step 7: Raw inserts in tests and in `users`**

Every raw insert into `authz_assignment` now needs `subject_key`. Find them:

Run: `grep -rnE "into\((AUTHZ_ASSIGNMENT_TABLE|'authz_assignment')\)" packages/authz-rbac/test packages/users/test`

- `test/integration/db-harness.ts:44`: add `subject_key: subjectKeyOf(a.subject),` to the values and `subjectKeyOf` to the `../../src/index.js` import. Also add `AUTHZ_SUBJECT_MEMBERSHIP_TABLE` to `CLEARED` (line 28) in Task 3, when the constant exists.
- `test/migrations/user-role-drop.test.ts:90`, `test/migrations/user-roles-copy.test.ts:172,189,368`: each row is a `user` principal; add `subject_key: \`user:${<the subject_id expression of that row>}\`` to each values object.
- `packages/users/test/migration/rbac.migration.ts:17`: add `subject_key: \`user:${uuid}\`,` to the values.
- `packages/users/test/role-assignments.test.ts:62-67`: change the import to `import { AUTHZ_ASSIGNMENT_TABLE, subjectFromColumns, subjectKeyOf } from '@spinajs/authz-rbac';` and the values to

```ts
    .values({ id: uuidv4(), subject_role: '', scope_id: '', tags: '', expires_at: null, granted_by: null, source: 'test', created_at: new Date(), ...row, subject_key: subjectKeyOf(subjectFromColumns(row.subject_type, row.subject_id, row.subject_role ?? '')) });
```

In `test/migrations/user-roles-copy.test.ts`, in the first case that reads copied rows from `authz_assignment`, add per row `expect(r.subject_key).to.eq(\`user:${r.subject_id}\`);`.

- [ ] **Step 8: Run the tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`. A deep-equal on a raw `authz_assignment` row that now has an extra `subject_key` fails with an `expected … to deeply equal` diff showing `subject_key`: add the key to that expectation.

Run: `cd packages/authz-rbac && npm run compile && cd ../users && npm test`
Expected: `0 failing` for the tests that do not depend on the old authz-orm list scoping (L5 owns those).

- [ ] **Step 9: Commit**

```bash
git add -A packages/authz-rbac packages/users/test
git commit -m "feat(authz-rbac): authz_assignment.subject_key, subjectKeyOf and key reads (design §4.2)"
```

---

### Task 2: The closure algorithm

**Files:**
- Create: `packages/authz-rbac/src/membership/closure.ts`, `packages/authz-rbac/src/membership/index.ts`
- Modify: `packages/authz-rbac/src/index.ts`
- Test: `packages/authz-rbac/test/membership/closure.test.ts`

**Interfaces:**
- Produces: `latestPerSet(rows): { setKey; expiresAt?: Date }[]` (what `MembershipStore.setsOf` answers), `MembershipEdge { memberKey; setKey; expiresAt: Date | null }`, `MembershipRow { memberKey; setKey; depth; expiresAt: Date | null }`, `EdgeSource = (memberKeys: readonly string[]) => Promise<readonly MembershipEdge[]>`, `computeClosures(memberKeys, edgesFrom, maxDepth): Promise<Map<string, MembershipRow[]>>` (rows sorted by `setKey`), `DEFAULT_MAX_SET_DEPTH = 8`, `readMaxSetDepth(value: unknown): number`.

- [ ] **Step 1: Write the failing test**

Create `test/membership/closure.test.ts`:

```ts
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';

import { computeClosures, latestPerSet, readMaxSetDepth } from '../../src/index.js';
import type { MembershipEdge } from '../../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const H = 3_600_000;
const T0 = Date.parse('2026-10-14T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * H);
const edge = (memberKey: string, setKey: string, expiresAt: Date | null = null): MembershipEdge => ({ memberKey, setKey, expiresAt });

function source(edges: readonly MembershipEdge[]) {
  const reads: string[][] = [];
  return {
    reads,
    read: async (keys: readonly string[]) => {
      reads.push([...keys].sort());
      return edges.filter((e) => keys.includes(e.memberKey));
    },
  };
}

const closures = (members: string[], edges: readonly MembershipEdge[], maxDepth = 8) => computeClosures(members, source(edges).read, maxDepth);

const CHAIN = [edge('user:u', 'g:3#m'), edge('g:3#m', 'g:2#m'), edge('g:2#m', 'g:1#m')];

describe('computeClosures (design §4.3)', () => {
  it('walks nested sets three levels up, with the shortest depth', async () => {
    expect((await closures(['user:u'], CHAIN)).get('user:u')).to.deep.equal([
      { memberKey: 'user:u', setKey: 'g:1#m', depth: 3, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:2#m', depth: 2, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:3#m', depth: 1, expiresAt: null },
    ]);
  });

  it('expires a path at its earliest edge and a membership at its latest path', async () => {
    const edges = [edge('user:u', 'g:3#m', at(2)), edge('g:3#m', 'g:2#m', at(1)), edge('g:2#m', 'g:1#m'), edge('g:3#m', 'g:1#m', at(3))];
    expect((await closures(['user:u'], edges)).get('user:u')).to.deep.equal([
      // u-3-2-1 lives until 1h, u-3-1 until 2h: the later one wins.
      { memberKey: 'user:u', setKey: 'g:1#m', depth: 2, expiresAt: at(2) },
      { memberKey: 'user:u', setKey: 'g:2#m', depth: 2, expiresAt: at(1) },
      { memberKey: 'user:u', setKey: 'g:3#m', depth: 1, expiresAt: at(2) },
    ]);
  });

  it('a longer path can widen the expiry the shortest one found', async () => {
    const edges = [edge('user:u', 'g:a#m', at(1)), edge('user:u', 'g:b#m'), edge('g:b#m', 'g:a#m')];
    expect((await closures(['user:u'], edges)).get('user:u')).to.deep.equal([
      { memberKey: 'user:u', setKey: 'g:a#m', depth: 1, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:b#m', depth: 1, expiresAt: null },
    ]);
  });

  it('removing an edge shrinks the closure', async () => {
    const before = (await closures(['user:u'], CHAIN)).get('user:u')!.map((r) => r.setKey);
    const after = (await closures(['user:u'], CHAIN.slice(0, 2))).get('user:u')!.map((r) => r.setKey);
    expect(before).to.deep.equal(['g:1#m', 'g:2#m', 'g:3#m']);
    expect(after).to.deep.equal(['g:2#m', 'g:3#m']);
  });

  it('a member without edges has no rows', async () => {
    expect((await closures(['user:x'], CHAIN)).get('user:x')).to.deep.equal([]);
  });

  it('refuses a set that reaches itself (set_cycle)', async () => {
    const err = await closures(['g:1#m'], [edge('g:1#m', 'g:2#m'), edge('g:2#m', 'g:1#m')]).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzAdminFailure).and.include({ code: 'set_cycle' });
  });

  it('terminates on a cycle above the member that the member is not part of', async () => {
    const out = await closures(['user:u'], [edge('user:u', 'g:a#m'), edge('g:a#m', 'g:b#m'), edge('g:b#m', 'g:a#m')]);
    expect(out.get('user:u')!.map((r) => [r.setKey, r.depth])).to.deep.equal([['g:a#m', 1], ['g:b#m', 2]]);
  });

  it('refuses a set more than maxDepth levels up (set_too_deep), and accepts it at maxDepth', async () => {
    const err = await closures(['user:u'], CHAIN, 2).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzAdminFailure).and.include({ code: 'set_too_deep' });
    expect((await closures(['user:u'], CHAIN, 3)).get('user:u')).to.have.length(3);
  });

  it('reads the edges of all members level by level, each node once', async () => {
    const s = source([edge('user:u', 'g:1#m'), edge('user:v', 'g:1#m'), edge('g:1#m', 'g:0#m')]);
    const out = await computeClosures(['user:u', 'user:v'], s.read, 8);
    expect(s.reads).to.deep.equal([['user:u', 'user:v'], ['g:1#m'], ['g:0#m']]);
    expect(out.get('user:v')!.map((r) => r.setKey)).to.deep.equal(['g:0#m', 'g:1#m']);
  });

  it('latestPerSet keeps one entry per set at its latest expiry, none when a row never expires', () => {
    expect(latestPerSet([{ setKey: 'b', expiresAt: at(1) }, { setKey: 'a', expiresAt: at(2) }, { setKey: 'b', expiresAt: at(3) }, { setKey: 'a', expiresAt: null }])).to.deep.equal([{ setKey: 'a' }, { setKey: 'b', expiresAt: at(3) }]);
  });

  it('readMaxSetDepth takes the default for undefined and refuses a non-positive or fractional value', () => {
    expect(readMaxSetDepth(undefined)).to.eq(8);
    expect(readMaxSetDepth(3)).to.eq(3);
    for (const bad of [0, -1, 1.5, '4', null]) expect(() => readMaxSetDepth(bad), String(bad)).to.throw(AuthzConfigError);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/authz-rbac && npm test`
Expected: compile FAILS: `has no exported member 'computeClosures'`.

- [ ] **Step 3: Implement `src/membership/closure.ts`**

```ts
import { AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';

/** One live assignment that makes `memberKey` a direct member of `setKey`. */
export interface MembershipEdge {
  readonly memberKey: string;
  readonly setKey: string;
  /** null: never expires. */
  readonly expiresAt: Date | null;
}

/** One row of `authz_subject_membership`. */
export interface MembershipRow {
  readonly memberKey: string;
  readonly setKey: string;
  /** 1 = direct member; the shortest path otherwise. */
  readonly depth: number;
  readonly expiresAt: Date | null;
}

/** The live edges leaving each of `memberKeys`. */
export type EdgeSource = (memberKeys: readonly string[]) => Promise<readonly MembershipEdge[]>;

export const DEFAULT_MAX_SET_DEPTH = 8;

/** `authz.rbac.maxSetDepth`; the schema is the gate, this holds for values that never went through it. */
export function readMaxSetDepth(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_SET_DEPTH;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new AuthzConfigError(`authz.rbac.maxSetDepth must be an integer >= 1, got ${JSON.stringify(value)}`);
  return value;
}

const NEVER = Number.POSITIVE_INFINITY;

/** One entry per set, expiring at the latest of its rows (no `expiresAt` when one never expires); sorted by set key. */
export function latestPerSet(rows: readonly Pick<MembershipRow, 'setKey' | 'expiresAt'>[]): { setKey: string; expiresAt?: Date }[] {
  const latest = new Map<string, number>();
  for (const r of rows) {
    const until = r.expiresAt === null ? NEVER : r.expiresAt.getTime();
    if (until > (latest.get(r.setKey) ?? Number.NEGATIVE_INFINITY)) latest.set(r.setKey, until);
  }
  return [...latest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([setKey, until]) => (until === NEVER ? { setKey } : { setKey, expiresAt: new Date(until) }));
}

/**
 * The closure rows of each member: every set it reaches over the edges, at its shortest depth, expiring at the
 * latest over all paths of the earliest edge expiry on the path. The edges of all members are read level by
 * level together, so k members cost at most maxDepth + 1 reads, not k times that. Edges are cached per node.
 * @throws AuthzAdminFailure `set_cycle` when a member (a set) reaches itself; `set_too_deep` when a set lies
 *   more than `maxDepth` levels above a member
 */
export async function computeClosures(memberKeys: readonly string[], edgesFrom: EdgeSource, maxDepth: number): Promise<Map<string, MembershipRow[]>> {
  const members = [...new Set(memberKeys)];
  const adjacency = new Map<string, MembershipEdge[]>();
  const load = async (keys: readonly string[]): Promise<void> => {
    const missing = [...new Set(keys)].filter((k) => !adjacency.has(k));
    if (missing.length === 0) return;
    for (const k of missing) adjacency.set(k, []);
    for (const e of await edgesFrom(missing)) adjacency.get(e.memberKey)?.push(e);
  };

  const depths = new Map<string, Map<string, number>>(members.map((m) => [m, new Map()]));
  let frontiers = new Map<string, string[]>(members.map((m) => [m, [m]]));
  for (let level = 1; frontiers.size > 0; level++) {
    await load([...frontiers.values()].flat());
    const next = new Map<string, string[]>();
    for (const [member, frontier] of frontiers) {
      const seen = depths.get(member)!;
      const found: string[] = [];
      for (const node of frontier) {
        for (const e of adjacency.get(node)!) {
          if (e.setKey === member) throw new AuthzAdminFailure('set_cycle', `${member} would be a member of itself through ${node}`);
          if (seen.has(e.setKey)) continue;
          if (level > maxDepth) throw new AuthzAdminFailure('set_too_deep', `${e.setKey} would lie ${level} levels above ${member}; authz.rbac.maxSetDepth is ${maxDepth}`);
          seen.set(e.setKey, level);
          found.push(e.setKey);
        }
      }
      if (found.length > 0) next.set(member, found);
    }
    frontiers = next;
  }

  const out = new Map<string, MembershipRow[]>();
  for (const member of members) {
    // Max-min relaxation: a value only grows, and only to one of finitely many expiries, so it ends.
    const best = new Map<string, number>([[member, NEVER]]);
    const queue = [member];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const reach = best.get(node)!;
      for (const e of adjacency.get(node) ?? []) {
        const via = Math.min(reach, e.expiresAt === null ? NEVER : e.expiresAt.getTime());
        if (via > (best.get(e.setKey) ?? Number.NEGATIVE_INFINITY)) {
          best.set(e.setKey, via);
          queue.push(e.setKey);
        }
      }
    }
    const rows = [...depths.get(member)!]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([setKey, depth]): MembershipRow => {
        const until = best.get(setKey)!;
        return { memberKey: member, setKey, depth, expiresAt: until === NEVER ? null : new Date(until) };
      });
    out.set(member, rows);
  }
  return out;
}
```

`src/membership/index.ts`:

```ts
export * from './closure.js';
```

`src/index.ts`: add `export * from './membership/index.js';` after the stores export.

- [ ] **Step 4: Run the tests**

Run: `cd packages/authz-rbac && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json test/membership/closure.test.ts`
Expected: `10 passing`.
Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/src/membership packages/authz-rbac/src/index.ts packages/authz-rbac/test/membership/closure.test.ts
git commit -m "feat(authz-rbac): computeClosures, the subject set closure with max-min expiry (design §4.3)"
```

---

### Task 3: `authz_subject_membership` and its stores

**Files:**
- Modify: `src/migrations/AuthzRbac_2026_10_01_00_00_00.ts`, `src/admin/ports.ts`, `src/stores/defaults.ts`, `src/stores/register.ts`, `src/host/register.ts`, `src/stores/schema.ts`, `src/stores/index.ts`, `src/admin/memory/index.ts`
- Create: `src/stores/db-membership-store.ts`, `src/admin/memory/membership-store.ts`
- Test: `test/membership/stores.test.ts` (new), `test/migrations/authz-rbac-initial.test.ts`, `test/integration/db-harness.ts:28`, `test/stores/register.test.ts`

**Interfaces:**
- Consumes: `MembershipStore` (L0: `setsOf(memberKeys, at): Promise<readonly { setKey: string; expiresAt?: Date }[]>` — one entry per set, the latest expiry over the given members, none when a row never expires; `membersOf(setKey, at)`), `MembershipRow`, `latestPerSet` (Task 2).
- Produces: `AdminMembershipStore` (port, `src/admin/ports.ts`) with `name`, `rowsOf(memberKeys)`, `allMembersOf(setKeys)`, `memberKeys()`, `replace(memberKey, rows, tx)`; `DbMembershipStore`; `MemoryMembershipStore`; `AUTHZ_SUBJECT_MEMBERSHIP_TABLE = 'authz_subject_membership'`; store kind `membership` (`authz.rbac.stores.membership`); config `authz.rbac.maxSetDepth` (default 8).

- [ ] **Step 1: Write the failing tests**

Create `test/membership/stores.test.ts` (one contract, both stores):

```ts
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuthzConfigError, MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { AdminMembershipStore, DbMembershipStore, MembershipStore, MemoryMembershipStore } from '../../src/index.js';
import type { MembershipRow } from '../../src/index.js';
import { bootDb, DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const AT = new Date('2026-10-14T12:00:00.000Z');
const LATER = new Date(AT.getTime() + 3_600_000);
const EARLIER = new Date(AT.getTime() - 3_600_000);
const row = (memberKey: string, setKey: string, depth = 1, expiresAt: Date | null = null): MembershipRow => ({ memberKey, setKey, depth, expiresAt });

interface Subject {
  store: AdminMembershipStore;
  inTx<T>(fn: (tx: AuthzTx) => Promise<T>, commit?: boolean): Promise<void>;
}

const ROLLBACK = new Error('rollback');

function contract(name: string, setup: () => Promise<Subject>, teardown: () => Promise<void>) {
  describe(name, function () {
    this.timeout(60000);
    let s: Subject;
    before(async () => {
      s = await setup();
    });
    after(teardown);
    beforeEach(async () => {
      for (const k of await s.store.memberKeys()) await s.inTx((tx) => s.store.replace(k, [], tx));
    });

    it('is a MembershipStore', () => {
      expect(s.store).to.be.instanceOf(MembershipStore);
    });

    it('replace writes a member\'s rows and drops the old ones', async () => {
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:1#m'), row('user:u', 'g:2#m', 2, LATER)], tx));
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:2#m', 1)], tx));
      expect(await s.store.rowsOf(['user:u'])).to.deep.equal([row('user:u', 'g:2#m', 1)]);
    });

    it('setsOf and membersOf answer live rows only; rowsOf and allMembersOf keep expired ones', async () => {
      await s.inTx(async (tx) => {
        await s.store.replace('user:u', [row('user:u', 'g:1#m'), row('user:u', 'g:2#m', 1, EARLIER)], tx);
        await s.store.replace('user:v', [row('user:v', 'g:1#m', 2, LATER)], tx);
        await s.store.replace('g:3#m', [row('g:3#m', 'g:1#m')], tx);
      });
      expect(await s.store.setsOf(['user:u', 'user:v'], AT)).to.deep.equal([{ setKey: 'g:1#m' }]);
      expect(await s.store.membersOf('g:1#m', AT)).to.deep.equal(['g:3#m', 'user:u', 'user:v']);
      expect(await s.store.membersOf('g:2#m', AT)).to.deep.equal([]);
      expect(await s.store.allMembersOf(['g:2#m'])).to.deep.equal(['user:u']);
      expect((await s.store.rowsOf(['user:u'])).map((r) => r.setKey).sort()).to.deep.equal(['g:1#m', 'g:2#m']);
      expect(await s.store.memberKeys()).to.deep.equal(['g:3#m', 'user:u', 'user:v']);
      const [v] = await s.store.rowsOf(['user:v']);
      expect(v.expiresAt?.getTime()).to.eq(LATER.getTime());
      expect(v.depth).to.eq(2);
    });

    it('setsOf answers each set once, with the latest expiry of the given members', async () => {
      const LATEST = new Date(LATER.getTime() + 3_600_000);
      await s.inTx(async (tx) => {
        await s.store.replace('user:u', [row('user:u', 'g:5#m', 1, LATER), row('user:u', 'g:6#m', 1, LATER)], tx);
        await s.store.replace('user:v', [row('user:v', 'g:5#m', 1, LATEST), row('user:v', 'g:6#m')], tx);
      });
      const sets = await s.store.setsOf(['user:u', 'user:v'], AT);
      expect(sets.map((x) => [x.setKey, x.expiresAt?.getTime()])).to.deep.equal([['g:5#m', LATEST.getTime()], ['g:6#m', undefined]]);
      expect(sets[1]).to.not.have.property('expiresAt');
    });

    it('a rollback undoes replace', async () => {
      await s.inTx((tx) => s.store.replace('user:u', [row('user:u', 'g:1#m')], tx));
      await s.inTx((tx) => s.store.replace('user:u', [], tx), false);
      expect(await s.store.setsOf(['user:u'], AT)).to.deep.equal([{ setKey: 'g:1#m' }]);
    });
  });
}

const memoryBackend = new MemoryAuthzAdminBackend();
contract(
  'MemoryMembershipStore',
  async () => ({
    store: new MemoryMembershipStore(),
    inTx: async (fn, commit = true) => {
      await memoryBackend
        .transaction('test', async (tx) => {
          await fn(tx);
          if (!commit) throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
    },
  }),
  async () => undefined,
);

for (const kind of DB_KINDS) {
  let db: TestDb | undefined;
  describe(`DbMembershipStore (${kind})`, function () {
    before(async function () {
      db = await bootDb(this, kind, 'membership');
    });
    after(async () => {
      await db?.dispose();
    });

    contract(
      'contract',
      async () => ({
        store: db!.container.resolve(DbMembershipStore),
        inTx: async (fn, commit = true) => {
          await db!.driver
            .transaction(async (driver: OrmDriver) => {
              await fn({ driver });
              if (!commit) throw ROLLBACK;
            })
            .catch((e) => {
              if (e !== ROLLBACK) throw e;
            });
        },
      }),
      async () => undefined,
    );

    it('refuses to write outside a transaction', async () => {
      await expect(db!.container.resolve(DbMembershipStore).replace('user:u', [], { driver: db!.driver })).to.be.rejectedWith(AuthzConfigError, /transaction/);
    });
  });
}
```

In `test/migrations/authz-rbac-initial.test.ts`: add `'authz_subject_membership'` to `TABLES`; add to `SCHEMA`

```ts
  authz_subject_membership: [
    ['member_key', 'string', 200, false],
    ['set_key', 'string', 200, false],
    ['depth', 'int', null, false],
    ['expires_at', 'datetime', null, true],
  ],
```

to `PRIMARY_KEYS` `authz_subject_membership: ['member_key', 'set_key'],`, and to `'creates the §9.1 indexes'`

```ts
      expect(await find('authz_subject_membership', 'authz_subject_membership_set')).to.deep.eq({ name: 'authz_subject_membership_set', unique: false, columns: ['set_key'] });
```

In `test/stores/register.test.ts` add:

```ts
  it('registers DbMembershipStore by default next to DbAssignmentStore, and none next to another assignment store', () => {
    const cfg = (stores: Record<string, unknown> | undefined) => ({ get: (path: unknown) => (JSON.stringify(path) === JSON.stringify(['authz', 'rbac', 'stores', 'membership']) ? undefined : JSON.stringify(path) === JSON.stringify(['authz', 'rbac', 'stores', 'assignments']) ? stores?.assignments : undefined) }) as never;
    expect(rbacStoreNames(cfg(undefined), 'membership')).to.deep.equal(['DbMembershipStore']);
    expect(rbacStoreNames(cfg({ assignments: ['MemoryAssignmentStore'] }), 'membership')).to.deep.equal([]);
  });
```

(import `rbacStoreNames` from `../../src/index.js` if the file does not already).

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/authz-rbac && npm test`
Expected: compile FAILS: `has no exported member 'DbMembershipStore'`.

- [ ] **Step 3: Migration**

In `AuthzRbac_2026_10_01_00_00_00.up`, after the `authz_assignment` indexes:

```ts
    await connection.schema().createTable('authz_subject_membership', (table) => {
      table.string('member_key', 200).notNull().primaryKey();
      table.string('set_key', 200).notNull().primaryKey();
      table.int('depth').notNull();
      table.dateTime('expires_at');
    });

    await connection.index().table('authz_subject_membership').name('authz_subject_membership_set').columns(['set_key']);
```

In `down`, the list becomes `['authz_version', 'authz_link', 'authz_rule_subject', 'authz_rule', 'authz_subject_membership', 'authz_assignment']`. The class doc gains `, the closure of subject sets` after `assignments`.

- [ ] **Step 4: Port**

`src/admin/ports.ts`: change line 3 to `import { AssignmentStore, LinkStore, MembershipStore, RuleStore } from '../contracts.js';`, add `import type { MembershipRow } from '../membership/closure.js';`, and append:

```ts
/** The closure table AuthzAdmin maintains (design §4.3); `replace` runs inside the batch transaction. */
export abstract class AdminMembershipStore extends MembershipStore {
  abstract readonly name: string;
  /** The stored rows of these members, expired ones too. */
  abstract rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]>;
  /** Members with a stored row for any of these sets, expired ones too: everything below them. Sorted. */
  abstract allMembersOf(setKeys: readonly string[]): Promise<readonly string[]>;
  /** Every member key with a stored row. Sorted. */
  abstract memberKeys(): Promise<readonly string[]>;
  /** Replaces every stored row of `memberKey` with `rows`. */
  abstract replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void>;
}
```

- [ ] **Step 5: `DbMembershipStore`**

Create `src/stores/db-membership-store.ts`:

```ts
import type { AuthzTx } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { AdminMembershipStore } from '../admin/ports.js';
import { latestPerSet } from '../membership/closure.js';
import type { MembershipRow } from '../membership/closure.js';
import { toDate } from './columns.js';
import { storeConnection, storeTransactionDriver } from './context.js';
import { whereLive } from './queries.js';

export const AUTHZ_SUBJECT_MEMBERSHIP_TABLE = 'authz_subject_membership';

const KEY_BATCH = 500;
// 4 columns a row: 800 bound parameters, under SQLite's 999.
const INSERT_BATCH = 200;

interface StoredRow {
  readonly member_key: string;
  readonly set_key: string;
  readonly depth: number | string;
  readonly expires_at: Date | string | null;
}

const toRow = (r: StoredRow): MembershipRow => ({ memberKey: String(r.member_key), setKey: String(r.set_key), depth: Number(r.depth), expiresAt: toDate(r.expires_at) });
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * `MembershipStore` over `authz_subject_membership` (design §4.3), on the `authz.rbac.connection` connection.
 * The RBAC write handlers keep it right inside each AuthzAdmin batch; `authz:membership-rebuild` rewrites it.
 * Registered by class name; `authz.rbac.stores.membership` selects it.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbMembershipStore extends AdminMembershipStore {
  readonly name: string = 'DbMembershipStore';

  constructor(protected readonly container: IContainer) {
    super();
  }

  async setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return latestPerSet((await this.select('member_key', memberKeys, at)).map(toRow));
  }

  async membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    return sorted((await this.select('set_key', [setKey], at)).map((r) => r.member_key));
  }

  async rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]> {
    return (await this.select('member_key', memberKeys)).map(toRow);
  }

  async allMembersOf(setKeys: readonly string[]): Promise<readonly string[]> {
    return sorted((await this.select('set_key', setKeys)).map((r) => r.member_key));
  }

  async memberKeys(): Promise<readonly string[]> {
    const driver = await this.connection();
    return sorted(((await driver.select().from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE).columns(['member_key'])) as unknown as StoredRow[]).map((r) => r.member_key));
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    const driver = storeTransactionDriver(tx, await this.connection(), `${this.name}.replace`);
    await driver.del().from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE).where('member_key', memberKey);
    const values = rows.map((r) => ({ member_key: memberKey, set_key: r.setKey, depth: r.depth, expires_at: r.expiresAt }));
    for (let i = 0; i < values.length; i += INSERT_BATCH) {
      await driver
        .insert()
        .into(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)
        .values(values.slice(i, i + INSERT_BATCH));
    }
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** Rows whose `column` is one of `keys`, in batches; `at` undefined keeps expired rows. */
  private async select(column: 'member_key' | 'set_key', keys: readonly string[], at?: Date): Promise<StoredRow[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const driver = await this.connection();
    const out: StoredRow[] = [];
    for (let i = 0; i < unique.length; i += KEY_BATCH) {
      const query = driver.select().from(AUTHZ_SUBJECT_MEMBERSHIP_TABLE).whereIn(column, unique.slice(i, i + KEY_BATCH));
      if (at) whereLive(query, at);
      out.push(...((await query) as unknown as StoredRow[]));
    }
    return out;
  }
}
```

`src/stores/index.ts`: add `export * from './db-membership-store.js';` after `db-link-store`.

- [ ] **Step 6: `MemoryMembershipStore`**

Create `src/admin/memory/membership-store.ts`:

```ts
import { memoryTx } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';

import { latestPerSet } from '../../membership/closure.js';
import type { MembershipRow } from '../../membership/closure.js';
import { AdminMembershipStore } from '../ports.js';
import { isLive } from '../rows.js';

const copy = (r: MembershipRow): MembershipRow => Object.freeze({ ...r, expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt.getTime()) });
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

/**
 * The closure table in a map, written inside a MemoryAuthzAdminBackend transaction. Not registered: tests and
 * memory hosts register one instance under MembershipStore and AdminMembershipStore.
 */
export class MemoryMembershipStore extends AdminMembershipStore {
  readonly name: string;
  private readonly rows = new Map<string, readonly MembershipRow[]>();

  constructor(opts: { readonly name?: string } = {}) {
    super();
    this.name = opts.name ?? 'memory';
  }

  async setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return latestPerSet([...new Set(memberKeys)].flatMap((k) => (this.rows.get(k) ?? []).filter((r) => isLive(r.expiresAt, at))));
  }

  async membersOf(setKey: string, at: Date): Promise<readonly string[]> {
    return sorted(this.all().filter((r) => r.setKey === setKey && isLive(r.expiresAt, at)).map((r) => r.memberKey));
  }

  async rowsOf(memberKeys: readonly string[]): Promise<readonly MembershipRow[]> {
    return [...new Set(memberKeys)].flatMap((k) => this.rows.get(k) ?? []).map(copy);
  }

  async allMembersOf(setKeys: readonly string[]): Promise<readonly string[]> {
    const wanted = new Set(setKeys);
    return sorted(this.all().filter((r) => wanted.has(r.setKey)).map((r) => r.memberKey));
  }

  async memberKeys(): Promise<readonly string[]> {
    return sorted(this.rows.keys());
  }

  async replace(memberKey: string, rows: readonly MembershipRow[], tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    const before = this.rows.get(memberKey);
    if (rows.length > 0) this.rows.set(memberKey, Object.freeze(rows.map((r) => copy({ ...r, memberKey }))));
    else this.rows.delete(memberKey);
    undo.onRollback(() => {
      if (before) this.rows.set(memberKey, before);
      else this.rows.delete(memberKey);
    });
  }

  private all(): MembershipRow[] {
    return [...this.rows.values()].flat();
  }
}
```

`src/admin/memory/index.ts`: add `export * from './membership-store.js';`.

- [ ] **Step 7: Store kind and config**

`src/stores/defaults.ts`:

```ts
export type RbacStoreKind = 'roles' | 'assignments' | 'rules' | 'links' | 'membership';

export const RBAC_STORE_DEFAULTS: Readonly<Record<RbacStoreKind, readonly string[]>> = Object.freeze({
  roles: Object.freeze(['ConfigRoleStore']),
  assignments: Object.freeze(['DbAssignmentStore']),
  rules: Object.freeze(['ConfigRuleStore']),
  links: Object.freeze(['DbLinkStore']),
  membership: Object.freeze(['DbMembershipStore']),
});

/** `authz.rbac.stores.<kind>` when the app sets it, else the default; duplicates dropped, order kept. */
export function rbacStoreNames(config: Pick<Configuration, 'get'>, kind: RbacStoreKind): readonly string[] {
  const configured = config.get<string[] | undefined>(['authz', 'rbac', 'stores', kind]);
  // The closure is derived from the assignment rows, so the DB table is the default only next to the DB assignment store.
  if (configured === undefined && kind === 'membership') return rbacStoreNames(config, 'assignments').includes('DbAssignmentStore') ? RBAC_STORE_DEFAULTS.membership : [];
  return [...new Set(configured ?? RBAC_STORE_DEFAULTS[kind])];
}
```

`src/stores/register.ts`: import `MembershipStore` from `../contracts.js` and `AdminMembershipStore` from `../admin/ports.js`; add to `PORTS`: `membership: { token: MembershipStore, admin: AdminMembershipStore },`.

`src/host/register.ts` after `count('links', 0, 1);` add `count('membership', 0, 1);`.

`src/stores/schema.ts`: import `DEFAULT_MAX_SET_DEPTH` from `'../membership/closure.js'`; line 155 `stores` gains `membership: stringList`; add after `connection: name,`:

```ts
    // Levels a membership walk may climb (design §4.3); a deeper nesting is refused when written (set_too_deep).
    maxSetDepth: { type: 'integer', minimum: 1, maximum: 64, default: DEFAULT_MAX_SET_DEPTH },
```

`test/integration/db-harness.ts`: add `AUTHZ_SUBJECT_MEMBERSHIP_TABLE` to the `../../src/index.js` import and to `CLEARED` before `AUTHZ_ASSIGNMENT_TABLE`.

- [ ] **Step 8: Run the tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`; the new suites `MemoryMembershipStore` and `DbMembershipStore (sqlite)` pass.

- [ ] **Step 9: Commit**

```bash
git add -A packages/authz-rbac
git commit -m "feat(authz-rbac): authz_subject_membership with DbMembershipStore and MemoryMembershipStore (design §4.3)"
```

---

### Task 4: `forgetScope`: the memory store matches the DB store

`DbAssignmentStore.forgetScope` (`src/stores/db-assignment-store.ts:202-217`) deletes the rows AT the scope and every row whose subject is a set living at the scope. `MemoryAdminAssignmentStore.forgetScope` (`src/admin/memory/assignment-store.ts:102-107`), `RbacScopeForgetter`'s doc (`src/admin/forgetter.ts:8-12`) and `AdminAssignmentStore.forgetScope`'s doc (`src/admin/ports.ts:26`) say set-subject rows stay. The DB behaviour is the safe one (design §6.4: an id reused after a delete must inherit nothing), so memory and docs follow it.

**Files:**
- Modify: `src/admin/memory/assignment-store.ts:102-107`, `src/admin/forgetter.ts:8-12`, `src/admin/ports.ts:26`
- Test: `test/admin/memory-stores.test.ts:156-165`

- [ ] **Step 1: Change the test**

Replace the test at `test/admin/memory-stores.test.ts:156-165` with

```ts
  it('forgetScope removes the rows at the scope and every row whose subject is a set at it, as DbAssignmentStore does', async () => {
    const atOrg = await grant({ scope: O1, role: 'org.member' });
    const setSubject = await grant({ subject: MEMBERS, scope: P1 });
    const elsewhere = await grant({ scope: P2 });
    const gone = await inTx(backend, (tx) => store.forgetScope(O1, tx));
    expect(gone!.map((r) => r.id).sort()).to.deep.equal([atOrg.id, setSubject.id].sort());
    expect(await store.byId(atOrg.id)).to.equal(null);
    expect(await store.byId(setSubject.id)).to.equal(null);
    expect(await store.byId(elsewhere.id)).to.not.equal(null);
  });
```

(`MEMBERS` in that file is the `org.member` set at `O1`.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/authz-rbac && npm test`
Expected: FAIL in "forgetScope removes the rows at the scope and every row whose subject is a set at it": `expected [ '<id>' ] to deeply equal [ '<id>', '<id>' ]`.

- [ ] **Step 3: Fix the memory store and the docs**

`src/admin/memory/assignment-store.ts`: import `isSetSubject` from `'../rows.js'` and change line 104 to

```ts
    const gone = [...this.rows.values()].filter((a) => sameRef(a.scope, scope) || (isSetSubject(a.subject) && sameRef(a.subject.set.scope, scope)));
```

`src/admin/ports.ts` line 26 becomes

```ts
  /** Removes every row AT the scope and every row whose subject is a set at it, wherever held; returns the removed rows. */
```

`src/admin/forgetter.ts` lines 8-12 become

```ts
/**
 * scope.forget for RBAC data AT the node: links (with their assignments), assignments, rules, and every grant
 * whose subject is a set living at the node, wherever it is held, so a later node with the same id inherits
 * nothing. A store the domain does not register holds nothing to forget.
 */
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`. If a behaviour case in `test/admin/*.test.ts` asserted the old memory behaviour, it fails naming `scope.forget`; change its expectation to the DB behaviour.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/src/admin packages/authz-rbac/test/admin/memory-stores.test.ts
git commit -m "fix(authz-rbac): the memory forgetScope also drops grants of sets at the scope, as the DB store does"
```

---

### Task 5: Closure maintenance in the admin batch, with precise cache tags

**Files:**
- Create: `packages/authz-rbac/src/admin/membership.ts`
- Modify: `src/admin/assignments.ts:82-141`, `src/admin/links.ts:40-66`, `src/admin/forgetter.ts:16-43`, `src/admin/common.ts:55-76`, `src/admin/index.ts`
- Test: `packages/authz-rbac/test/admin/membership.test.ts`

**Interfaces:**
- Consumes: `computeClosures`, `readMaxSetDepth` (Task 2), `AdminMembershipStore` (Task 3), `AdminAssignmentStore.forSubjectKeys` (Task 1), `roleIndex`, `setRolesOf`, `honoured`, `optionalStore`, `subjectTag` (`src/admin/common.ts`).
- Produces: `membershipEdges(roles: RoleIndex, rows: readonly Assignment[]): MembershipEdge[]`; `refreshMemberships(ctx: AdminContext, tx: AuthzTx, touched: readonly AssignmentSubject[]): Promise<string[]>` (cache tags); `subjectTags(ctx, subject): Promise<string[]>`; `memberSubjects(ctx, rows): Promise<AssignmentSubject[]>`; `MEMBERSHIP_TAG_LIMIT = 1000`; `loadRoleIndex(container: IContainer, where: string): Promise<RoleIndex>` (exported from `src/admin/common.ts`; Task 6 uses it).

- [ ] **Step 1: Write the failing test**

Create `test/admin/membership.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';
import type { AuthzCommand, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { AdminMembershipStore, MembershipStore, MemoryMembershipStore } from '../../src/index.js';
import type { AssignmentSubject } from '../../src/index.js';
import { HOUR, START, config, failure, installHost, instance, ok, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const DAVE: PrincipalRef = { type: 'user', id: 'dave' };
const group = (id: string): ResourceRef => ({ type: 'group', id });
const set = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const key = (id: string) => `group:${id}#group.member`;
const at = (hours: number) => new Date(START.getTime() + hours * HOUR);

const join = (member: PrincipalRef, id: string, expiresAt?: Date): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(id) }, member, ...(expiresAt ? { expiresAt } : {}) });
const nest = (child: string, parent: string, expiresAt?: Date): AuthzCommand => ({ kind: 'assignment.grant', subject: set(child), role: 'group.member', scope: group(parent), ...(expiresAt ? { expiresAt } : {}) });

describe('subject set closure maintenance (design §4.3)', function () {
  this.timeout(20000);
  let d: RbacDomain;
  let m: MemoryMembershipStore;

  before(async () => {
    await installHost();
  });
  after(async () => {
    await uninstallHost();
  });
  beforeEach(async () => {
    await resetHost();
    m = new MemoryMembershipStore();
    d = await rbacDomain('test', {
      register: (c) => {
        c.register(instance(m)).as(MembershipStore);
        c.register(instance(m)).as(AdminMembershipStore);
      },
    });
  });
  afterEach(() => {
    config().set(['authz', 'rbac', 'maxSetDepth'], undefined);
  });

  const run = async (...commands: AuthzCommand[]) => ok(await d.admin.execute(alice, commands));
  const sets = async (keys: string[], when: Date) => (await m.setsOf(keys, when)).map((s) => s.setKey);

  it('nests three levels whatever the order of the writes', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'));
    await run(nest('g2', 'g1'));
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g1'), key('g2'), key('g3')]);
    expect(await m.membersOf(key('g1'), START)).to.deep.equal([key('g2'), key('g3'), 'user:dave']);
    expect((await m.rowsOf(['user:dave'])).map((r) => [r.setKey, r.depth])).to.deep.equal([[key('g1'), 3], [key('g2'), 2], [key('g3'), 1]]);
  });

  it('expires a path at its earliest edge and a membership at its latest path', async () => {
    await run(nest('g2', 'g1'), nest('g3', 'g1', at(3)), nest('g3', 'g2', at(1)), join(DAVE, 'g3', at(2)));
    const rows = new Map((await m.rowsOf(['user:dave'])).map((r) => [r.setKey, r.expiresAt?.getTime()]));
    expect(rows).to.deep.equal(new Map([[key('g1'), at(2).getTime()], [key('g2'), at(1).getTime()], [key('g3'), at(2).getTime()]]));
    expect(await sets(['user:dave'], at(1.5))).to.deep.equal([key('g1'), key('g3')]);
  });

  it('setExpiry on a membership row recomputes the members below it', async () => {
    await run(join(DAVE, 'g2'), nest('g2', 'g1', at(1)));
    const [row] = (await d.assignments.find({ subject: set('g2'), at: START })).items;
    await run({ kind: 'assignment.setExpiry', id: row.id, expiresAt: at(5) });
    expect((await m.rowsOf(['user:dave'])).find((r) => r.setKey === key('g1'))?.expiresAt?.getTime()).to.eq(at(5).getTime());
  });

  it('a revoke shrinks the closure of every member below', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'assignment.revokeWhere', scope: group('g2'), subject: set('g3'), role: 'group.member' });
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g3')]);
    expect(await m.membersOf(key('g1'), START)).to.deep.equal([key('g2')]);
  });

  it('set.removeMember drops the member from every set above', async () => {
    await run(join(DAVE, 'g2'), nest('g2', 'g1'));
    await run({ kind: 'set.removeMember', set: { role: 'group.member', scope: group('g2') }, member: DAVE });
    expect(await sets(['user:dave'], START)).to.deep.equal([]);
  });

  it('refuses a cycle (set_cycle) and rolls the batch back', async () => {
    await run(nest('g1', 'g2'));
    expect(failure(await d.admin.execute(alice, [nest('g2', 'g1')]))).to.include({ at: 0, code: 'set_cycle' });
    expect(await sets([key('g1')], START)).to.deep.equal([key('g2')]);
    expect((await d.assignments.find({ subject: set('g2'), at: START })).total).to.eq(0);
  });

  it('refuses a nesting deeper than authz.rbac.maxSetDepth (set_too_deep)', async () => {
    config().set(['authz', 'rbac', 'maxSetDepth'], 2);
    await run(join(DAVE, 'g3'), nest('g3', 'g2'));
    expect(failure(await d.admin.execute(alice, [nest('g2', 'g1')]))).to.include({ at: 0, code: 'set_too_deep' });
  });

  it('scope.forget of a set\'s node drops its memberships and the members\' rows through it', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'scope.forget', scope: group('g2') });
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g3')]);
    expect(await m.memberKeys()).to.deep.equal(['user:dave']);
  });

  it('set.addMember tags the member and the set, never the set role', async () => {
    await run(join(DAVE, 'g3'));
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g3')}`, 'subject:user:dave']);
  });

  it('a nesting tags the sets that changed and the members below, not every decision', async () => {
    await run(join(DAVE, 'g3'));
    await run(nest('g3', 'g2'));
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g2')}`, 'subject:group:g3', `subject:${key('g3')}`, 'subject:user:dave'].sort());
  });

  it('removing a member tags every set it left', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'set.removeMember', set: { role: 'group.member', scope: group('g3') }, member: DAVE });
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g1')}`, `subject:${key('g2')}`, `subject:${key('g3')}`, 'subject:user:dave'].sort());
  });

  it('a grant to a set tags the set and its live members', async () => {
    await run(join(DAVE, 'g3'));
    await run({ kind: 'assignment.grant', subject: set('g3'), role: 'editor', scope: { type: 'project', id: 'p1' } });
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal(['subject:group:g3', `subject:${key('g3')}`, 'subject:user:dave']);
  });

  it('without an AdminMembershipStore nothing is maintained and a set grant keeps its role tag', async () => {
    await resetHost();
    const plain = await rbacDomain('plain');
    ok(await plain.admin.execute(alice, [join(DAVE, 'g3'), nest('g3', 'g2')]));
    expect(plain.bus.published.at(-1)!.tags).to.include('role:group.member');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/authz-rbac && npm test`
Expected: FAIL in "subject set closure maintenance": `expected [] to deeply equal [ 'group:g1#group.member', … ]` (nothing maintains the table yet).

- [ ] **Step 3: `loadRoleIndex`**

In `src/admin/common.ts` add `import type { Class, IContainer } from '@spinajs/di';` (replacing the `Class`-only import) and replace `loadRoles` (lines 55-76) with

```ts
async function loadRoles(ctx: AdminContext): Promise<RoleIndex> {
  return loadRoleIndex(adminContainer(ctx), `Authz domain ${q(ctx.domain)}`);
}

/** The role definitions of every RoleStore `container` registers; a role or ladder defined twice is refused. */
export async function loadRoleIndex(container: IContainer, where: string): Promise<RoleIndex> {
  if (!container.hasRegistered(RoleStore)) throw new AuthzConfigError(`${where}: no RoleStore is registered; the RBAC write handlers of AuthzAdmin read role definitions from it`);
  const roles = new Map<string, RoleDef>();
  const ladders = new Map<string, LadderDef>();
  for (const s of await container.resolve(Array.chainOf(RoleStore))) {
    const loaded = await (s as RoleStore).load();
    for (const r of loaded.roles) {
      if (roles.has(r.name)) throw new AuthzConfigError(`${where}: role ${q(r.name)} is defined twice (${roles.get(r.name)!.source}, ${r.source})`);
      roles.set(r.name, r);
    }
    for (const l of loaded.ladders) {
      if (ladders.has(l.name)) throw new AuthzConfigError(`${where}: ladder ${q(l.name)} is defined twice`);
      ladders.set(l.name, l);
    }
  }
  const listed = new Map<string, string>();
  for (const l of ladders.values()) for (const r of l.roles) listed.set(r, l.name);
  return { roles, ladders, ladderOf: (role) => roles.get(role)?.ladder ?? listed.get(role) };
}
```

- [ ] **Step 4: `src/admin/membership.ts`**

```ts
import { adminContainer } from '@spinajs/authz';
import type { AdminContext, AuthzTx } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';

import type { Assignment, AssignmentSubject } from '../contracts.js';
import { computeClosures, readMaxSetDepth } from '../membership/closure.js';
import type { MembershipEdge, MembershipRow } from '../membership/closure.js';
import { subjectKeyOf } from '../stores/columns.js';
import { assignmentStore, honoured, optionalStore, roleIndex, setRolesOf, subjectTag } from './common.js';
import type { RoleIndex } from './common.js';
import { AdminMembershipStore } from './ports.js';
import { isLive, isSetSubject } from './rows.js';

/** Above this many changed members a write tags `*`: a member's cached decisions carry only its own subject tag. */
export const MEMBERSHIP_TAG_LIMIT = 1000;

/** The membership edges of assignment rows: a row the model honours, for each subjectSet role its role holds. */
export function membershipEdges(roles: RoleIndex, rows: readonly Assignment[]): MembershipEdge[] {
  const setRoles = new Map<string, readonly string[]>();
  const out: MembershipEdge[] = [];
  for (const row of rows) {
    if (!honoured(roles, row)) continue;
    if (!setRoles.has(row.role)) setRoles.set(row.role, setRolesOf(roles, row.role));
    for (const role of setRoles.get(row.role)!) out.push({ memberKey: subjectKeyOf(row.subject), setKey: subjectKeyOf({ set: { role, scope: row.scope } }), expiresAt: row.expiresAt ?? null });
  }
  return out;
}

/** The subjects of the rows whose role makes them a set member: only those need a refresh. */
export async function memberSubjects(ctx: AdminContext, rows: readonly Pick<Assignment, 'subject' | 'role'>[]): Promise<AssignmentSubject[]> {
  if (rows.length === 0) return [];
  const roles = await roleIndex(ctx);
  return rows.filter((r) => setRolesOf(roles, r.role).length > 0).map((r) => r.subject);
}

async function maxSetDepth(ctx: AdminContext): Promise<number> {
  const container = adminContainer(ctx);
  const configuration = container.hasRegistered(Configuration) ? ((await container.resolve(Configuration)) as Configuration) : undefined;
  return readMaxSetDepth(configuration?.get<unknown>(['authz', 'rbac', 'maxSetDepth']));
}

const liveEntries = (rows: readonly MembershipRow[], now: Date): Map<string, string> =>
  new Map(rows.filter((r) => isLive(r.expiresAt, now)).map((r) => [`${r.setKey}\u0000${r.expiresAt?.getTime() ?? ''}`, r.setKey]));

/**
 * Recomputes, inside the batch transaction, the closure rows of `touched` and of every member below them (a
 * change above a set changes the sets of all its members). Call it after the assignment rows changed. Returns
 * the tags of the change: `subject:<setKey>` for every set that gained, lost or re-expired a member,
 * `subject:<memberKey>` for the touched members and for every member whose live sets changed (`*` in their
 * place past MEMBERSHIP_TAG_LIMIT), never `role:` (ChangeAudience narrows pushes by these keys). A domain
 * without an AdminMembershipStore keeps no closure and returns none.
 * @throws AuthzAdminFailure `set_cycle` or `set_too_deep` before any closure row is written
 */
export async function refreshMemberships(ctx: AdminContext, tx: AuthzTx, touched: readonly AssignmentSubject[]): Promise<string[]> {
  if (touched.length === 0) return [];
  const memberships = await optionalStore(ctx, AdminMembershipStore);
  if (!memberships) return [];
  const roles = await roleIndex(ctx);
  const assignments = await assignmentStore(ctx);
  const keys = [...new Set(touched.map(subjectKeyOf))];
  const affected = [...new Set([...keys, ...(await memberships.allMembersOf(keys))])].sort();
  const before = await memberships.rowsOf(affected);
  const after = await computeClosures(affected, async (k) => membershipEdges(roles, await assignments.forSubjectKeys(k, ctx.now)), await maxSetDepth(ctx));
  for (const k of affected) await memberships.replace(k, after.get(k) ?? [], tx);

  const changed: string[] = [];
  const sets = new Set<string>();
  for (const k of affected) {
    const was = liveEntries(before.filter((r) => r.memberKey === k), ctx.now);
    const is = liveEntries(after.get(k) ?? [], ctx.now);
    const moved = [...[...was].filter(([e]) => !is.has(e)), ...[...is].filter(([e]) => !was.has(e))];
    if (moved.length === 0) continue;
    changed.push(k);
    for (const [, setKey] of moved) sets.add(setKey);
  }
  if (changed.length === 0) return [];
  // A set key tag matches no cached decision; AssignmentCache drops every set entry on any subject: tag.
  const tags = [...sets, ...keys].map((k) => `subject:${k}`);
  if (changed.length <= MEMBERSHIP_TAG_LIMIT) tags.push(...changed.map((k) => `subject:${k}`));
  else tags.push('*');
  return [...new Set(tags)];
}

/**
 * Tags of an assignment's subject: a principal's own. For a set, with a closure table: `subject:<setKey>`, the
 * set's node as a principal (a `group` principal speaks for its set and is in no closure row) and its live
 * members (`*` in their place past MEMBERSHIP_TAG_LIMIT). Without a closure table the set role, as before: no
 * member list exists to narrow it.
 */
export async function subjectTags(ctx: AdminContext, s: AssignmentSubject): Promise<string[]> {
  if (!isSetSubject(s)) return [subjectTag(s)];
  const memberships = await optionalStore(ctx, AdminMembershipStore);
  if (!memberships) return [subjectTag(s)];
  const setKey = subjectKeyOf(s);
  const members = await memberships.membersOf(setKey, ctx.now);
  const scope = s.set.scope;
  const own = [`subject:${setKey}`, ...(scope.id === undefined ? [] : [subjectTag({ type: scope.type, id: scope.id })])];
  return members.length > MEMBERSHIP_TAG_LIMIT ? [...own, '*'] : [...own, ...members.map((k) => `subject:${k}`)];
}
```

`src/admin/index.ts`: add `export * from './membership.js';` and `export { loadRoleIndex } from './common.js';`.

- [ ] **Step 5: Wire the assignment handler**

In `src/admin/assignments.ts` add the import `import { memberSubjects, refreshMemberships, subjectTags } from './membership.js';` and replace `apply` (lines 82-141) with:

```ts
  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<Applied> {
    const store = await assignmentStore(ctx);
    const actor = actorRef(ctx);
    // Tags are read before the refresh: they name the members as the batch found them.
    const done = async (applied: Applied, rows: readonly Pick<Assignment, 'subject' | 'role'>[]): Promise<Applied> => {
      const membership = await refreshMemberships(ctx, tx, await memberSubjects(ctx, rows));
      return { ...applied, tags: [...new Set([...applied.tags, ...membership])] };
    };
    const tagsOf = async (rows: readonly Pick<Assignment, 'subject'>[]) => [...new Set((await Promise.all(rows.map((a) => subjectTags(ctx, a.subject)))).flat())];
    switch (c.kind) {
      case 'assignment.grant': {
        const g = await this.grantOf(c, ctx);
        const events: AuthzEvent[] = [];
        const { revoke } = await plannedRemovals(c, ctx);
        for (const other of revoke) {
          await store.revoke(other.id, actor, tx);
          events.push(revoked(ctx, other));
        }
        const row = await store.assign({ subject: g.subject, role: g.role, scope: g.scope, tags: g.tags, expiresAt: g.expiresAt }, actor, tx);
        events.push(assigned(ctx, row));
        return done({ id: row.id, affected: revoke.length + 1, tags: await tagsOf([row]), events, row }, [row, ...revoke]);
      }
      case 'assignment.revoke': {
        const row = await this.row(c, ctx);
        const tags = await tagsOf([row]);
        await store.revoke(row.id, actor, tx);
        return done({ id: row.id, affected: 1, tags, events: [revoked(ctx, row)] }, [row]);
      }
      case 'assignment.revokeWhere': {
        this.whereOf(c);
        const items = (await plannedRemovals(c, ctx)).revoke;
        const tags = await tagsOf(items);
        for (const a of items) await store.revoke(a.id, actor, tx);
        return done({ affected: items.length, tags, events: items.map((a) => revoked(ctx, a)) }, items);
      }
      case 'assignment.setTags':
      case 'assignment.addTags':
      case 'assignment.removeTags': {
        const row = await this.row(c, ctx);
        const given = readTags(c.tags);
        const old = row.tags ?? [];
        const tags = c.kind === 'assignment.setTags' ? given : c.kind === 'assignment.addTags' ? [...old, ...given] : old.filter((t) => !given.includes(t));
        const next = await store.update(row.id, { tags }, actor, tx);
        return { id: next.id, affected: 1, tags: await tagsOf([next]), events: [changed(ctx, next)] };
      }
      case 'assignment.setExpiry': {
        const row = await this.row(c, ctx);
        const next = await store.update(row.id, { expiresAt: readFutureExpiry(c.expiresAt, ctx) ?? null }, actor, tx);
        return done({ id: next.id, affected: 1, tags: await tagsOf([next]), events: [changed(ctx, next)] }, [next]);
      }
      case 'set.addMember': {
        const m = await this.memberOf(c, ctx);
        const row = await store.assign({ subject: m.member, role: m.role, scope: m.scope, tags: [], expiresAt: m.expiresAt }, actor, tx);
        return done({ id: row.id, affected: 1, tags: [subjectTag(row.subject)], events: [assigned(ctx, row)] }, [row]);
      }
      case 'set.removeMember': {
        const set = setOf(c);
        const member = readPrincipal(c.member, 'member');
        refuseLinkSubject(member, 'member');
        const items = (await plannedRemovals(c, ctx)).revoke;
        if (items.length === 0) throw new AuthzAdminFailure('not_found', `${quote(member)} is not a member of ${quote(set.role)} at the set scope`, 'member');
        for (const a of items) await store.revoke(a.id, actor, tx);
        return done({ id: items[0].id, affected: items.length, tags: [subjectTag(member)], events: items.map((a) => revoked(ctx, a)) }, items);
      }
      default:
        throw new AuthzAdminFailure('not_found', `RbacAssignmentHandler does not handle ${quote((c as AuthzCommand).kind)}`);
    }
  }
```

(`Assignment` is already imported as a type at line 5.)

- [ ] **Step 6: Wire the link handler and the forgetter**

`src/admin/links.ts`: import `refreshMemberships` from `'./membership.js'`. In `apply`, for `link.create`, `link.update` (after `regrant`, not on the early no-op return) and `link.revoke`, compute

```ts
        const membership = await refreshMemberships(ctx, tx, [{ type: 'link', id: link.id }]);
```

after the store write and return `tags: [...linkTags(link.id), ...membership]` in place of `tags: linkTags(link.id)`. (A link's role may hold a subjectSet role; without a closure store this is a no-op.)

`src/admin/forgetter.ts`: import `memberSubjects, refreshMemberships, subjectTags` from `'./membership.js'` and `AssignmentSubject` (type) from `'../contracts.js'`; change `forget` to collect and refresh:

```ts
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    const tags = new Set<string>();
    const events: AuthzEvent[] = [];
    const touched: AssignmentSubject[] = [];
    let affected = 0;

    const links = await optionalStore(ctx, AdminLinkStore);
    for (const l of (await links?.forgetScope(scope, tx)) ?? []) {
      affected++;
      touched.push({ type: LINK_TYPE, id: l.id });
      for (const t of linkTags(l.id)) tags.add(t);
      events.push(event(ctx, 'LinkRevoked', { id: l.id, scope: l.scope }));
    }

    const assignments = await optionalStore(ctx, AdminAssignmentStore);
    const gone = (await assignments?.forgetScope(scope, tx)) ?? [];
    for (const a of gone) {
      affected++;
      // Read before the refresh below rewrites the closure: the members as the batch found them.
      for (const t of await subjectTags(ctx, a.subject)) tags.add(t);
      events.push(event(ctx, 'RoleRevoked', { id: a.id, subject: a.subject, role: a.role, scope: a.scope }));
    }
    touched.push(...(await memberSubjects(ctx, gone)));

    const rules = await optionalStore(ctx, AdminRuleStore);
    for (const r of (await rules?.forgetScope(scope, tx)) ?? []) {
      affected++;
      tags.add(`rule:${r.id}`);
      events.push(event(ctx, 'RuleChanged', { id: r.id, scope: r.scope, op: 'delete' }));
    }

    for (const t of await refreshMemberships(ctx, tx, touched)) tags.add(t);
    return { affected, tags: [...tags], events };
  }
```

(`LINK_TYPE` comes from `./common.js`.) `memberSubjects` loads the role index only when `gone` is non-empty, so a domain without roles that forgets an empty scope keeps working. Note: L2's `forgetScopesInTx` runs every `ScopeForgetter`, so a resource delete refreshes the closure too.

- [ ] **Step 7: HTTP status of the new codes (authz-http-admin)**

`packages/authz-http-admin/src/routes/status.ts` maps every code that is not a refusal, `not_found` or `conflict` to 400, the status of the other validation codes (`invalid_command`, `unknown_role`, …). `set_cycle` and `set_too_deep` are validation failures of the command, so they get 400 with no code change; pin it and document it:

- `packages/authz-http-admin/test/helpers.test.ts:88`: add `'set_cycle', 'set_too_deep'` to the list of codes expected to be 400.
- `packages/authz-http-admin/src/schemas/bodies.ts:39`: in the `AuthzAdminError` description, add `set_cycle, set_too_deep` to the 400 group, after `invalid_attributes`.

Run: `cd packages/authz-http-admin && npm test`
Expected: `0 failing`.

- [ ] **Step 8: Run the tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`, including the DB behaviour suites (`test/integration/behaviour.db.test.ts`), where `registerRbacStores` now registers `DbMembershipStore` next to `DbAssignmentStore`.

- [ ] **Step 9: Commit**

```bash
git add -A packages/authz-rbac packages/authz-http-admin/test/helpers.test.ts packages/authz-http-admin/src/schemas/bodies.ts
git commit -m "feat(authz-rbac): keep authz_subject_membership right in every AuthzAdmin batch, with member tags (design §4.3)"
```

---

### Task 6: `authz:membership-verify` and `authz:membership-rebuild`

**Files:**
- Create: `packages/authz-rbac/src/membership/maintenance.ts`, `packages/authz-rbac/src/cli/commands/membership.ts`
- Modify: `src/membership/index.ts`, `src/cli/index.ts`
- Test: `packages/authz-rbac/test/cli/membership.test.ts`

**Interfaces:**
- Consumes: `computeClosures`, `readMaxSetDepth`, `membershipEdges`, `loadRoleIndex`, `setRolesOf`, `honoured`, `AdminAssignmentStore.find`/`forSubjectKeys`, `AdminMembershipStore`, `DbAuthzAdminBackend`.
- Produces: `MembershipSources { roles; assignments; memberships; maxDepth; now }`, `expectedMemberships(s)`, `diffMemberships(s): Promise<MembershipDiff>`, `rebuildMemberships(s, tx): Promise<number>`; commands `MembershipVerifyCommand` (`authz:membership-verify`, exit 1 on any difference) and `MembershipRebuildCommand` (`authz:membership-rebuild [--domain <name>]`).

- [ ] **Step 1: Write the failing test**

Create `test/cli/membership.test.ts`:

```ts
import { expect } from 'chai';
import 'mocha';
import type { AuthzService, PrincipalRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { DbAssignmentStore, DbAuthzAdminBackend, DbMembershipStore, MembershipRebuildCommand, MembershipVerifyCommand, MemoryRoleStore, RoleStore, loadRoleIndex } from '../../src/index.js';
import type { MembershipCliContext, RoleDef } from '../../src/index.js';
import { bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { capture } from './fixture.js';

const ROLES: RoleDef[] = [{ name: 'group.member', extends: [], grants: [], assignable: true, subjectSet: true, scopeTypes: ['group'], source: 'test' }];
const alice: PrincipalRef = { type: 'user', id: 'alice' };
const g = (id: string) => ({ type: 'group', id });
const passThrough = { runAs: (_p: unknown, _r: unknown, fn: () => Promise<unknown>) => fn() } as unknown as AuthzService;

describe('authz:membership-verify and authz:membership-rebuild (sqlite)', function () {
  this.timeout(60000);
  let db: TestDb;
  let ctx: MembershipCliContext;

  before(async function () {
    db = await bootDb(this, 'sqlite', 'membership_cli');
    const roles = db.container.child();
    roles.register(testHost.instance(new MemoryRoleStore(ROLES, []))).as(RoleStore);
    ctx = {
      roles: await loadRoleIndex(roles, 'test'),
      assignments: db.container.resolve(DbAssignmentStore),
      memberships: db.container.resolve(DbMembershipStore),
      backend: new DbAuthzAdminBackend({ container: db.container }),
      maxDepth: 8,
    };
    // Rows written past AuthzAdmin, as an import would: the closure table stays empty.
    await ctx.backend.transaction('root', async (tx) => {
      await ctx.assignments.assign({ subject: alice, role: 'group.member', scope: g('g2') }, alice, tx);
      await ctx.assignments.assign({ subject: { set: { role: 'group.member', scope: g('g2') } }, role: 'group.member', scope: g('g1') }, alice, tx);
    });
  });
  after(async () => {
    await db?.dispose();
  });

  const run = async (cmd: MembershipVerifyCommand | MembershipRebuildCommand) => {
    cmd.Authz = passThrough;
    cmd.Membership = ctx;
    const io = capture();
    try {
      await cmd.execute();
      return { out: [...io.out], err: [...io.err], exitCode: io.exitCode() };
    } finally {
      io.restore();
    }
  };

  it('verify reports the missing rows and exits 1', async () => {
    const r = await run(new MembershipVerifyCommand());
    expect(r.out).to.deep.equal(['missing group:g2#group.member in group:g1#group.member depth 1', 'missing user:alice in group:g1#group.member depth 2', 'missing user:alice in group:g2#group.member depth 1']);
    expect(r.err[0]).to.contain('3 difference(s)');
    expect(r.exitCode).to.eq(1);
  });

  it('rebuild writes the closure, and verify is clean after it', async () => {
    const rebuilt = await run(new MembershipRebuildCommand());
    expect(rebuilt.out[0]).to.match(/^3 membership row\(s\) written/);
    expect(rebuilt.exitCode).to.eq(undefined);
    expect(await ctx.memberships.setsOf(['user:alice'], new Date())).to.deep.equal([{ setKey: 'group:g1#group.member' }, { setKey: 'group:g2#group.member' }]);
    const verified = await run(new MembershipVerifyCommand());
    expect(verified).to.deep.equal({ out: ['OK: authz_subject_membership matches the assignments'], err: [], exitCode: undefined });
  });

  it('verify reports a row no assignment explains, and rebuild removes it', async () => {
    await ctx.backend.transaction('root', (tx) => ctx.memberships.replace('user:ghost', [{ memberKey: 'user:ghost', setKey: 'group:g9#group.member', depth: 1, expiresAt: null }], tx));
    expect((await run(new MembershipVerifyCommand())).out).to.deep.equal(['extra user:ghost in group:g9#group.member depth 1']);
    await run(new MembershipRebuildCommand());
    expect(await ctx.memberships.memberKeys()).to.not.include('user:ghost');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/authz-rbac && npm test`
Expected: compile FAILS: `has no exported member 'MembershipVerifyCommand'`.

- [ ] **Step 3: `src/membership/maintenance.ts`**

```ts
import type { AuthzTx } from '@spinajs/authz';

import { honoured, setRolesOf } from '../admin/common.js';
import type { RoleIndex } from '../admin/common.js';
import { membershipEdges } from '../admin/membership.js';
import type { AdminAssignmentStore, AdminMembershipStore } from '../admin/ports.js';
import { isLive } from '../admin/rows.js';
import { subjectKeyOf } from '../stores/columns.js';
import { computeClosures } from './closure.js';
import type { MembershipRow } from './closure.js';

export interface MembershipSources {
  readonly roles: RoleIndex;
  readonly assignments: AdminAssignmentStore;
  readonly memberships: AdminMembershipStore;
  readonly maxDepth: number;
  readonly now: Date;
}

export interface MembershipDiff {
  readonly missing: readonly MembershipRow[];
  readonly extra: readonly MembershipRow[];
  readonly changed: readonly { readonly stored: MembershipRow; readonly expected: MembershipRow }[];
}

/** The closure the live assignment rows give: every subject of a row whose role holds a subjectSet role. */
export async function expectedMemberships(s: MembershipSources): Promise<Map<string, MembershipRow[]>> {
  const members = new Set<string>();
  for (const role of s.roles.roles.keys()) {
    if (setRolesOf(s.roles, role).length === 0) continue;
    for (const a of (await s.assignments.find({ role, at: s.now })).items) if (honoured(s.roles, a)) members.add(subjectKeyOf(a.subject));
  }
  return computeClosures([...members].sort(), async (keys) => membershipEdges(s.roles, await s.assignments.forSubjectKeys(keys, s.now)), s.maxDepth);
}

const pair = (r: MembershipRow): string => JSON.stringify([r.memberKey, r.setKey]);
const same = (a: MembershipRow, b: MembershipRow): boolean => a.depth === b.depth && (a.expiresAt?.getTime() ?? null) === (b.expiresAt?.getTime() ?? null);
const byPair = (a: MembershipRow, b: MembershipRow): number => (pair(a) < pair(b) ? -1 : pair(a) > pair(b) ? 1 : 0);

/** Live stored rows against the expected closure; expired stored rows are ignored (they no longer count). */
export async function diffMemberships(s: MembershipSources): Promise<MembershipDiff> {
  const expected = await expectedMemberships(s);
  const keys = [...new Set([...(await s.memberships.memberKeys()), ...expected.keys()])];
  const want = new Map([...expected.values()].flat().map((r) => [pair(r), r]));
  const have = new Map((await s.memberships.rowsOf(keys)).filter((r) => isLive(r.expiresAt, s.now)).map((r) => [pair(r), r]));
  return {
    missing: [...want].filter(([k]) => !have.has(k)).map(([, r]) => r).sort(byPair),
    extra: [...have].filter(([k]) => !want.has(k)).map(([, r]) => r).sort(byPair),
    changed: [...want].filter(([k, r]) => have.has(k) && !same(have.get(k)!, r)).map(([k, r]) => ({ stored: have.get(k)!, expected: r })),
  };
}

/** Rewrites every member's rows inside `tx`; returns the number of rows written. */
export async function rebuildMemberships(s: MembershipSources, tx: AuthzTx): Promise<number> {
  const expected = await expectedMemberships(s);
  const keys = [...new Set([...(await s.memberships.memberKeys()), ...expected.keys()])].sort();
  let written = 0;
  for (const k of keys) {
    const rows = expected.get(k) ?? [];
    await s.memberships.replace(k, rows, tx);
    written += rows.length;
  }
  return written;
}
```

`src/membership/index.ts`: add `export * from './maintenance.js';`.

- [ ] **Step 4: `src/cli/commands/membership.ts`**

```ts
import { AuthzAdminBackend } from '@spinajs/authz';
import { Command, Option } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

import { DbAuthzAdminBackend } from '../../admin/db/backend.js';
import { loadRoleIndex } from '../../admin/common.js';
import { AdminAssignmentStore, AdminMembershipStore } from '../../admin/ports.js';
import { readMaxSetDepth } from '../../membership/closure.js';
import type { MembershipRow } from '../../membership/closure.js';
import { diffMemberships, rebuildMemberships } from '../../membership/maintenance.js';
import type { MembershipSources } from '../../membership/maintenance.js';
import { rbacStoreNames } from '../../stores/defaults.js';
import type { RbacStoreKind } from '../../stores/defaults.js';
import { CliUsageError } from '../args.js';
import { AuthzCliCommand } from '../base.js';

/** What the membership commands work on; tests set it, the CLI resolves it from the root container. */
export interface MembershipCliContext extends Omit<MembershipSources, 'now'> {
  readonly backend: AuthzAdminBackend;
}

const describeRow = (r: MembershipRow): string => `${r.memberKey} in ${r.setKey} depth ${r.depth}${r.expiresAt ? ` until ${r.expiresAt.toISOString()}` : ''}`;

abstract class MembershipCommand extends AuthzCliCommand {
  public Membership?: MembershipCliContext;

  protected async membership(): Promise<MembershipCliContext> {
    if (this.Membership) return this.Membership;
    const root = DI.RootContainer;
    const configuration = await DI.resolve(Configuration);
    const store = async <T>(token: Class<T>, kind: RbacStoreKind): Promise<T> => {
      if (root.hasRegistered(token)) return (await root.resolve(token)) as T;
      const [name] = rbacStoreNames(configuration, kind);
      if (name === undefined || !root.hasRegistered(name)) throw new CliUsageError(`no ${token.name} (authz.rbac.stores.${kind}): the membership commands need the RBAC DB stores`);
      return (await DI.resolve(name)) as T;
    };
    return {
      roles: await loadRoleIndex(root, 'authz:membership'),
      assignments: await store(AdminAssignmentStore, 'assignments'),
      memberships: await store(AdminMembershipStore, 'membership'),
      backend: new DbAuthzAdminBackend(),
      maxDepth: readMaxSetDepth(configuration.get(['authz', 'rbac', 'maxSetDepth'])),
    };
  }
}

@Command('authz:membership-verify', 'Recomputes authz_subject_membership from the assignments; lists missing, extra and changed rows, exit code 1 on any')
export class MembershipVerifyCommand extends MembershipCommand {
  public async execute(): Promise<void> {
    await this.command(
      () => undefined,
      async () => {
        const diff = await diffMemberships({ ...(await this.membership()), now: new Date() });
        for (const r of diff.missing) this.out(`missing ${describeRow(r)}`);
        for (const r of diff.extra) this.out(`extra ${describeRow(r)}`);
        for (const c of diff.changed) this.out(`changed ${describeRow(c.stored)} -> ${describeRow(c.expected)}`);
        const n = diff.missing.length + diff.extra.length + diff.changed.length;
        if (n === 0) this.out('OK: authz_subject_membership matches the assignments');
        else this.fail(`${n} difference(s); run authz:membership-rebuild`);
      },
    );
  }
}

@Command('authz:membership-rebuild', 'Rewrites authz_subject_membership from the assignments in one transaction')
@Option('-d, --domain <name>', false, 'the authz domain whose authz_version is bumped; default root')
export class MembershipRebuildCommand extends MembershipCommand {
  public async execute(options: { domain?: string } = {}): Promise<void> {
    await this.command(
      () => ({ domain: options.domain ?? 'root' }),
      async ({ domain }) => {
        const m = await this.membership();
        const written = await m.backend.transaction(domain, async (tx) => {
          const n = await rebuildMemberships({ ...m, now: new Date() }, tx);
          await m.backend.bumpVersion(domain, tx);
          return n;
        });
        this.out(`${written} membership row(s) written; running apps drop cached decisions when their caches expire or restart`);
      },
    );
  }
}
```

`src/cli/index.ts`: add `export * from './commands/membership.js';`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`; `authz:membership-verify and authz:membership-rebuild (sqlite)` 3 passing.

- [ ] **Step 6: Commit**

```bash
git add -A packages/authz-rbac
git commit -m "feat(authz-rbac): authz:membership-verify and authz:membership-rebuild (design §4.3)"
```

---

### Task 7: Set-in-set membership for teams (teams lanes L14/L15)

The shapes the teams design (§3) writes: a team set holding group sets, group sets nested in group sets, sub-team sets inside a parent team set, members through roles that extend a set role, and a group moved from one team to another in one batch. Tasks 2, 5 and 6 already handle them: `membershipEdges` turns every row whose role closure (`setRolesOf`: `extends` and the lower roles of its ladder) holds a subjectSet role into an edge, and `refreshMemberships` recomputes the touched subject and every member below it after each command, inside the batch, so a later command of the same batch sees the earlier ones. This task pins that behaviour with the teams roles and checks each end state with `authz:membership-verify`. No production code changes unless a case fails (Step 3).

**Files:**
- Test: `packages/authz-rbac/test/admin/membership-teams.test.ts`

**Interfaces:**
- Consumes: `MemoryMembershipStore`, `MembershipStore`, `AdminMembershipStore` (Task 3), the RBAC handlers with `refreshMemberships` (Task 5), `MembershipVerifyCommand`, `MembershipCliContext`, `loadRoleIndex` (Task 6), `rbacDomain`, `StaticRoleStore` (`test/admin/support.ts`), `capture` (`test/cli/fixture.ts`).
- Note for L14: `set.addMember` takes a principal member only (`member: PrincipalRef` in the frozen `AuthzCommand`). A set joins a set through `assignment.grant { subject: { set }, role: <set role>, scope }`, as below; the teams design's `set.addMember { member: { set } }` is refused by `readPrincipal`.

- [ ] **Step 1: Write the test**

Create `packages/authz-rbac/test/admin/membership-teams.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzCommand, AuthzService, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';

import { AdminMembershipStore, MembershipStore, MembershipVerifyCommand, MemoryMembershipStore, loadRoleIndex } from '../../src/index.js';
import type { AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { capture } from '../cli/fixture.js';
import { START, StaticRoleStore, failure, installHost, instance, ok, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
// Teams design §4 without grants: membership reads only subjectSet, extends, ladders and scopeTypes.
const TEAM_ROLES: RoleDef[] = [
  role('team.member', { subjectSet: true, scopeTypes: ['team'], ladder: 'team' }),
  role('team.admin', { scopeTypes: ['team'], ladder: 'team', extends: ['team.member'] }),
  role('team.owner', { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'] }),
  role('group.member', { subjectSet: true, scopeTypes: ['group'] }),
  role('group.manager', { scopeTypes: ['group'], extends: ['group.member'] }),
];
const TEAM_LADDERS: LadderDef[] = [{ name: 'team', roles: ['team.member', 'team.admin', 'team.owner'] }];

const alice = userPrincipal('alice');
const user = (id: string): PrincipalRef => ({ type: 'user', id });
const team = (id: string): ResourceRef => ({ type: 'team', id });
const group = (id: string): ResourceRef => ({ type: 'group', id });
const teamSet = (id: string): AssignmentSubject => ({ set: { role: 'team.member', scope: team(id) } });
const groupSet = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const TK = (id: string) => `team:${id}#team.member`;
const GK = (id: string) => `group:${id}#group.member`;

const joinGroup = (u: string, g: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(g) }, member: user(u) });
const joinTeam = (u: string, t: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'team.member', scope: team(t) }, member: user(u) });
const groupInGroup = (inner: string, outer: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(inner), role: 'group.member', scope: group(outer) });
const groupInTeam = (g: string, t: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(g), role: 'team.member', scope: team(t) });
const teamInTeam = (child: string, parent: string): AuthzCommand => ({ kind: 'assignment.grant', subject: teamSet(child), role: 'team.member', scope: team(parent) });
const unlinkGroup = (g: string, t: string): AuthzCommand => ({ kind: 'assignment.revokeWhere', scope: team(t), subject: groupSet(g), role: 'team.member' });

const passThrough = { runAs: (_p: unknown, _r: unknown, fn: () => Promise<unknown>) => fn() } as unknown as AuthzService;

describe('set-in-set membership for teams (teams design §3)', function () {
  this.timeout(20000);
  let d: RbacDomain;
  let m: MemoryMembershipStore;

  before(async () => {
    await installHost();
  });
  after(async () => {
    await uninstallHost();
  });
  beforeEach(async () => {
    await resetHost();
    m = new MemoryMembershipStore();
    d = await rbacDomain('test', {
      roleStores: [new StaticRoleStore('teams', TEAM_ROLES, TEAM_LADDERS)],
      permissions: { 'authz:assignments.manage': { types: ['org', 'project', 'file', 'group', 'team'] } },
      register: (c) => {
        c.register(instance(m)).as(MembershipStore);
        c.register(instance(m)).as(AdminMembershipStore);
      },
    });
  });

  const run = async (...commands: AuthzCommand[]) => ok(await d.admin.execute(alice, commands));
  const depths = async (memberKey: string) => (await m.rowsOf([memberKey])).map((r) => [r.setKey, r.depth]);
  const members = (setKey: string) => m.membersOf(setKey, START);

  /** authz:membership-verify over the domain's stores reports no difference. */
  async function verified(): Promise<void> {
    const cmd = new MembershipVerifyCommand();
    cmd.Authz = passThrough;
    cmd.Membership = { roles: await loadRoleIndex(d.container, 'test'), assignments: d.assignments, memberships: m, backend: new MemoryAuthzAdminBackend(), maxDepth: 8 };
    const io = capture();
    try {
      await cmd.execute();
      expect({ out: [...io.out], err: [...io.err], exitCode: io.exitCode() }).to.deep.equal({ out: ['OK: authz_subject_membership matches the assignments'], err: [], exitCode: undefined });
    } finally {
      io.restore();
    }
  }

  it('team ⊃ group ⊃ group ⊃ user, whatever the order of the writes', async () => {
    await run(joinGroup('dave', 'g2'), groupInGroup('g2', 'g1'), groupInTeam('g1', 't1'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t1'), 3]]);
    expect(await members(TK('t1'))).to.deep.equal([GK('g1'), GK('g2'), 'user:dave']);
    await run(groupInTeam('g3', 't2'));
    await run(groupInGroup('g4', 'g3'));
    await run(joinGroup('erin', 'g4'));
    expect(await depths('user:erin')).to.deep.equal([[GK('g3'), 2], [GK('g4'), 1], [TK('t2'), 3]]);
    await verified();
  });

  it('a sub-team set inside its parent team set; a cycle through teams is refused', async () => {
    await run(joinTeam('ann', 't1'), joinGroup('dave', 'g1'), groupInTeam('g1', 't1'), teamInTeam('t1', 'tp'));
    expect(await depths('user:ann')).to.deep.equal([[TK('t1'), 1], [TK('tp'), 2]]);
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2], [TK('tp'), 3]]);
    expect(await members(TK('tp'))).to.deep.equal([GK('g1'), TK('t1'), 'user:ann', 'user:dave']);
    expect(failure(await d.admin.execute(alice, [teamInTeam('tp', 't1')]))).to.include({ at: 0, code: 'set_cycle' });
    await run({ kind: 'assignment.revokeWhere', scope: team('tp'), subject: teamSet('t1'), role: 'team.member' });
    expect(await depths('user:ann')).to.deep.equal([[TK('t1'), 1]]);
    expect(await members(TK('tp'))).to.deep.equal([]);
    await verified();
  });

  it('membership through a role that extends a subject-set role, held by a user or by a set', async () => {
    await run({ kind: 'assignment.grant', subject: user('erin'), role: 'team.admin', scope: team('t1') });
    expect(await depths('user:erin')).to.deep.equal([[TK('t1'), 1]]);
    await run({ kind: 'assignment.grant', subject: user('erin'), role: 'team.owner', scope: team('t1'), replaceLadder: true });
    expect((await d.assignments.find({ subject: user('erin'), at: START })).items.map((a) => a.role)).to.deep.equal(['team.owner']);
    expect(await depths('user:erin')).to.deep.equal([[TK('t1'), 1]]);
    await run(joinGroup('dave', 'g1'), { kind: 'assignment.grant', subject: groupSet('g1'), role: 'team.admin', scope: team('t1') });
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2]]);
    await run({ kind: 'assignment.grant', subject: user('fay'), role: 'group.manager', scope: group('g1') });
    expect(await depths('user:fay')).to.deep.equal([[GK('g1'), 1], [TK('t1'), 2]]);
    await run({ kind: 'assignment.revokeWhere', scope: team('t1'), subject: user('erin') });
    expect(await depths('user:erin')).to.deep.equal([]);
    expect(await members(TK('t1'))).to.deep.equal([GK('g1'), 'user:dave', 'user:fay']);
    await verified();
  });

  it('moving a group set to another team in one batch (remove + add) leaves the closure exact', async () => {
    await run(joinGroup('dave', 'g2'), groupInGroup('g2', 'g1'), groupInTeam('g1', 't1'), joinTeam('ann', 't1'));
    await run(unlinkGroup('g1', 't1'), groupInTeam('g1', 't2'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t2'), 3]]);
    expect(await depths(GK('g1'))).to.deep.equal([[TK('t2'), 1]]);
    expect(await members(TK('t1'))).to.deep.equal(['user:ann']);
    expect(await members(TK('t2'))).to.deep.equal([GK('g1'), GK('g2'), 'user:dave']);
    await verified();
    // Add first, then remove: the same end state on the other team.
    await run(groupInTeam('g1', 't1'), unlinkGroup('g1', 't2'));
    expect(await depths('user:dave')).to.deep.equal([[GK('g1'), 2], [GK('g2'), 1], [TK('t1'), 3]]);
    expect(await members(TK('t2'))).to.deep.equal([]);
    await verified();
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/authz-rbac && npx tsc -b tsconfig.mjs.json && npx ts-mocha -p tsconfig.json test/admin/membership-teams.test.ts`
Expected: PASS, `4 passing`.

- [ ] **Step 3: Only if a case fails: fix the closure, not the test**

Use superpowers:systematic-debugging. The assertions are the teams design's contract; do not loosen them. Where to look, by symptom:

- A member misses a set reached through `team.admin`, `team.owner` or `group.manager`: `membershipEdges` (`src/admin/membership.ts`) must take `setRolesOf(roles, row.role)` (the closure with `extends` and lower ladder roles), not only `row.role`. `memberSubjects` must keep such rows for the refresh.
- A move leaves the old team in a member's rows: `refreshMemberships` must recompute `allMembersOf(keys)` from the stored rows before this command's write, and the edge source must read the batch's own writes (`forSubjectKeys` inside the transaction).
- `verified()` reports `changed … depth`: `computeClosures` must keep the shortest depth (Task 2 test "walks nested sets three levels up").

Add the failing shape to `test/membership/closure.test.ts` as a unit case first, fix, then rerun Step 2.

- [ ] **Step 4: Run the package**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/test/admin/membership-teams.test.ts
git commit -m "test(authz-rbac): set-in-set membership for teams, verified by authz:membership-verify"
```

(If Step 3 changed code, add `packages/authz-rbac/src` and `packages/authz-rbac/test/membership/closure.test.ts`, and use `fix(authz-rbac): …` naming the shape.)

---

## Contract issues found (resolved by the coordinator)

1. **Ambiguous keys:** resolved by escaping `%`, `#`, `*` in the id part (Task 1). L8 builds keys with `subjectKeyOf` only.
2. **Key width:** varchar(200) kept; longer keys refused on write (`invalid_command`, field `subject`).
3. **`set_cycle`, `set_too_deep`:** L0 adds them to the core codes comment; Task 5 Step 7 pins their HTTP status (400) in authz-http-admin.
4. **Maintenance in the handlers, not the backend:** accepted (overview decision 10).
5. **`AdminAssignmentStore.forSubjectKeys`** (abstract) and **`AdminMembershipStore`** are non-frozen port additions; any other `AdminAssignmentStore` must implement `forSubjectKeys`.
