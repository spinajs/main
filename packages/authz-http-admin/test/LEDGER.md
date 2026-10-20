# Test ledger: 2.x role tests ported to the admin routes

Rows of `packages/users-http/test/LEDGER.md` (file `users-controller.test.ts`) that name C4. All new tests are in
`test/legacy-roles.test.ts`; they run through the HTTP routes on AuthzAdmin with DefaultAdminGuard.

| Row | 2.x test | 3.0 test | Note |
|---|---|---|---|
| 56 | Roles > grants a role, keeping the existing ones | granting and revoking > keeps the roles the user already holds when it grants another | |
| 57 | Roles > does not duplicate an already granted role | granting and revoking > does not add a second row for an identical grant | the second grant answers 200 with the first row's id |
| 58 | Roles > revokes a role | granting and revoking > revokes one role and leaves the other | |
| 59 | Roles > rejects an empty role name | role validation > refuses an empty role name with 400 invalid_command | |
| 60 | Role guard > refuses a role that is not declared in configuration | role validation > refuses an unknown role with 400 unknown_role | |
| 61 | Role guard > refuses to hand out the system role | role validation > refuses a system role with 400 not_assignable | |
| 62 | Role guard > refuses to grant a role that holds more than the caller | escalation and lockout > refuses a role that holds more than the caller with 403 escalation | |
| 63 | Role guard > allows a stronger caller to grant that same role | escalation and lockout > lets a caller who covers the role grant it | |
| 64 | Role guard > refuses to revoke the caller s own privileged role | escalation and lockout > refuses revoking the caller's own privileged role with 403 self_lockout | |
| 67 | Role guard > is switchable: escalation may be allowed | guard switches > lets the escalation through with authz.admin.guard.preventEscalation off | |
| 68 | Role guard > is switchable: unknown roles may be allowed | guard switches > refuses an unknown role whatever authz.admin.guard says | 3.0 has no requireKnownRole switch |
| 69 | Role guard > is switchable: the system role may be handed out | guard switches > protectSystemRole on / off (two tests) | a grant of a system role is refused by validation either way; the switch governs revoking and editing its rows (protected_role) |
| 71 | Role guard > reports only the roles the caller may assign | roles the caller may assign > a dry run answers ok / escalation, and writes nothing | no list route (design 6.6.5); a UI asks with dryRun |

## test/route-verbs.test.ts (T3)

Row 4 of `packages/users-http/test/LEDGER.md` (`route-contract.test.ts`, "no state-changing route answers GET"), AuthzAdmin half.

| Row | 2.x test | 3.0 test | Note |
|---|---|---|---|
| route-contract 4 | Admin route contract > http verbs > no state-changing route answers GET | AuthzAdmin routes: http verbs > no state-changing route answers GET; declares routes; every read-only name is a real GET route | read-only list: listAssignments, listLinks, listRules, listPolicies, attributes |
