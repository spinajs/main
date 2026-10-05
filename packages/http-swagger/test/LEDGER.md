# Test ledger: @spinajs/http-swagger

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 12 |
| rewrite | 5 |
| drop | 0 |
| **total** | 17 |

Final places (C7): `swagger-policies` rows stay in `test/swagger-policies.test.ts`; the 2 adapt rows of `swagger-rbac`
are in `test/swagger-authz.test.ts`; the 5 rewrite rows sit in `test/legacy-v2/swagger-rbac.test.ts` (excluded by `.mocharc.json`; T4 replaces
them and deletes the file). The Target column gives the file and test name, then the T4 target for rewrite rows.

Scope: only the files below touch authorization or route metadata (`swagger-policies` covers the generic `@Policy` and is ledgered for completeness); the other test files of
this package are unchanged by the authz v3 plan and not ledgered.

Unledgered files (`it` count from the TSV):

- `test/swagger-build-failure.test.ts`: 4
- `test/swagger-files.test.ts`: 15
- `test/swagger-filter.test.ts`: 4
- `test/swagger-frommodel.test.ts`: 12
- `test/swagger-path-params-strict.test.ts`: 12
- `test/swagger-relation.test.ts`: 1
- `test/swagger-responses.test.ts`: 11
- `test/swagger-schema-generation.test.ts`: 17
- `test/swagger.test.ts`: 36

Ledgered 17, unledgered 112, package total 129.

Added by C7 (`it` count; the suite runs 130 specs):

- `test/swagger-authz.test.ts`: 6 (2 hold adapt rows of `swagger-rbac`, 4 are new)
- `test/swagger-authz-snapshot.test.ts`: 2

## test/swagger-policies.test.ts

10 tests; dominant class adapt (adapt 10).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 39 | Swagger policy extraction > should expose x-policies for routes inheriting controller-level @Policy | adapt | C7 | `test/swagger-policies.test.ts`: "should expose x-policies for routes inheriting controller-level @Policy" |
| 2 | 44 | Swagger policy extraction > should merge controller-level and route-level policies (controller first) | adapt | C7 | `test/swagger-policies.test.ts`: "should merge controller-level and route-level policies (controller first)" |
| 3 | 49 | Swagger policy extraction > should NOT set x-policies on controllers without any @Policy decorators | adapt | C7 | `test/swagger-policies.test.ts`: "should NOT set x-policies on controllers without any @Policy decorators" |
| 4 | 54 | Swagger policy extraction > should append a "Policies applied:" block to operation descriptions | adapt | C7 | `test/swagger-policies.test.ts`: "should append a "Policies applied:" block to operation descriptions" |
| 5 | 61 | Swagger policy extraction > should mark controller-level policies with the (controller) scope label | adapt | C7 | `test/swagger-policies.test.ts`: "should mark controller-level policies with the (controller) scope label" |
| 6 | 66 | Swagger policy extraction > should render a "Policies" reference section in info.description | adapt | C7 | `test/swagger-policies.test.ts`: "should render a "Policies" reference section in info.description" |
| 7 | 72 | Swagger policy extraction > should extract JSDoc descriptions of documented policies into the Policies section | adapt | C7 | `test/swagger-policies.test.ts`: "should extract JSDoc descriptions of documented policies into the Policies section" |
| 8 | 77 | Swagger policy extraction > should emit the fallback message for policies without JSDoc | adapt | C7 | `test/swagger-policies.test.ts`: "should emit the fallback message for policies without JSDoc" |
| 9 | 83 | Swagger policy extraction > should anchor each policy in info.description with a stable id | adapt | C7 | `test/swagger-policies.test.ts`: "should anchor each policy in info.description with a stable id" |
| 10 | 88 | Swagger policy extraction > should link operation descriptions to the policies section | adapt | C7 | `test/swagger-policies.test.ts`: "should link operation descriptions to the policies section" |

## test/swagger-rbac.test.ts

7 tests; dominant class rewrite (adapt 2, rewrite 5). The 2 rows on `@Resource` and its key stay adapt (C7 says "adapt tests"); the 5 rows that assert `x-rbac-*` ACL metadata are rewrite (T4 lists `swagger-rbac` as a rewrite suite).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 39 | Swagger RBAC extraction > should expose x-rbac-resource from controller @Resource decorator | adapt | C7 | `test/swagger-authz.test.ts`: "should expose x-authz-resource from the controller-level @Access" |
| 2 | 44 | Swagger RBAC extraction > should fall back to controller-level permissions when route has none | rewrite | C7 -> T4 | `test/legacy-v2/swagger-rbac.test.ts`: "should fall back to controller-level permissions when route has none". T4 target: http-swagger/test/v3/ (B23): `x-rbac-permissions` with possession verbs (`readOwn`, `readAny`, `createOwn`) becomes `x-authz-permission` with `resource:action` strings read from `ACCESS_DESCRIPTOR` (design §20 table: `@Access('X:read')`) |
| 3 | 49 | Swagger RBAC extraction > should override controller permissions with route-level @Permission | rewrite | C7 -> T4 | `test/legacy-v2/swagger-rbac.test.ts`: "should override controller permissions with route-level @Permission". T4 target: http-swagger/test/v3/ (B23): `x-rbac-permissions` with possession verbs (`readOwn`, `readAny`, `createOwn`) becomes `x-authz-permission` with `resource:action` strings read from `ACCESS_DESCRIPTOR` (design §20 table: `@Access('X:read')`) |
| 4 | 54 | Swagger RBAC extraction > should preserve all permission alternatives on a single route | rewrite | C7 -> T4 | `test/legacy-v2/swagger-rbac.test.ts`: "should preserve all permission alternatives on a single route". T4 target: http-swagger/test/v3/ (B23): `x-rbac-permissions` with possession verbs (`readOwn`, `readAny`, `createOwn`) becomes `x-authz-permission` with `resource:action` strings read from `ACCESS_DESCRIPTOR` (design §20 table: `@Access('X:read')`) |
| 5 | 59 | Swagger RBAC extraction > should append a human-readable RBAC line to the operation description | rewrite | C7 -> T4 | `test/legacy-v2/swagger-rbac.test.ts`: "should append a human-readable RBAC line to the operation description". T4 target: http-swagger/test/v3/ (B23): `x-rbac-permissions` with possession verbs (`readOwn`, `readAny`, `createOwn`) becomes `x-authz-permission` with `resource:action` strings read from `ACCESS_DESCRIPTOR` (design §20 table: `@Access('X:read')`) |
| 6 | 66 | Swagger RBAC extraction > should join multiple permissions with "or" in the description | rewrite | C7 -> T4 | `test/legacy-v2/swagger-rbac.test.ts`: "should join multiple permissions with "or" in the description". T4 target: http-swagger/test/v3/ (B23): `x-rbac-permissions` with possession verbs (`readOwn`, `readAny`, `createOwn`) becomes `x-authz-permission` with `resource:action` strings read from `ACCESS_DESCRIPTOR` (design §20 table: `@Access('X:read')`) |
| 7 | 71 | Swagger RBAC extraction > should NOT emit x-rbac-resource on controllers without RBAC metadata | adapt | C7 | `test/swagger-authz.test.ts`: "should NOT emit x-authz-* on controllers without @Access" |
