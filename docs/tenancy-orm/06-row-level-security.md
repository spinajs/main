# Row level security

On PostgreSQL and PGlite the database can enforce the tenant of a row-mode [tenant model](02-tenant-models.md) too.
`tenant:rls` writes a migration that puts row level security on the model's table, and `TenantSessionSettings` tells
the database the tenant of every statement. Raw SQL, `driver.execute(builder)`, a forgotten `.acrossTenants()` and a
reporting tool on a role of its own then see the rows of the tenant in scope, or none.

It is a second layer: `TenantScopeMiddleware` confines and refuses statements as before.

## How it works

1. A model declares `@Tenant({ rls: true })`, or `tenancy.orm.rls: true` applies to every row-mode model that sets
   nothing. A schema-mode model is never included: its table holds one tenant.
2. `npx spinajs tenant:rls -o <dir>` writes one migration per connection. For each table it:
   - runs `ENABLE` and `FORCE ROW LEVEL SECURITY`, so the table's owner is subject to the policies too;
   - creates the RESTRICTIVE policy `spina_tenant_isolation`: a row is visible and writable only when its tenant column
     equals the setting `spina.tenant`. A restrictive policy is ANDed with every other policy, so none can widen it;
   - creates the permissive policy `spina_tenant_open`, which grants what the restrictive policy lets through, but only
     while no other permissive policy is on the table. With `authz:rls` policies on the same table those decide which of
     the tenant's rows a principal sees, in whatever order the two migrations ran.
3. Inside `runInTenant(id)` every statement on such a connection runs in a transaction that first sets
   `spina.tenant = id` and `spina.tenant_all = 'off'`. Inside `runAcrossTenants(reason)` it sets `spina.tenant_all = 'on'`,
   which the policy honours for members of the bypass role only. Outside a scope nothing is set, and the table shows no
   row and takes no write.

The settings are local to the statement's transaction, so a pooled connection carries no tenant into the next
statement that uses it.

```ts
@Connection('default')
@Model('invoice')
@Tenant({ rls: true })
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  @Column({ family: 'text', length: 64 })
  public tenant_id: string;
}

await runInTenant('acme', async () => {
  await executeSql(sql`SELECT * FROM invoice`);   // acme's rows only
});
await executeSql(sql`SELECT * FROM invoice`);     // no tenant scope: no row
```

## Generating the policies

```sh
npx spinajs tenant:rls -o src/migrations --bypass-role app
npx spinajs migrate-up
```

| Option | Required | Meaning |
| --- | --- | --- |
| `-o, --out <dir>` | yes | Directory the migration is written to |
| `--bypass-role <role>` | no | Database role the all-tenants scope lets through; default `tenancy.orm.rlsBypassRole` |

The migration is named `TenantRls_<yyyy_MM_dd_HH_mm_ss>` (with `_<connection>` when several connections have such
tables) and runs on the models' connection. The command boots the Orm, so run `migrate-up` first. It refuses a table
with `rls` on a connection that is not PostgreSQL or PGlite, and writes nothing then.

Run it again after adding a model: each migration drops and re-creates the two tenant policies of every table it lists.

The tenant column must be a text type (`varchar`, `text`, `char`). The policy compares it with a text setting, so the
migration fails at `CREATE POLICY` for a `uuid` or an integer column ("operator does not exist").

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `tenancy.orm.rls` | `boolean` | `false` | `true`, `false` | `rls` of a model that sets none |
| `tenancy.orm.rlsBypassRole` | `string` | unset | a role name | Role the all-tenants scope lets through, written into the policy |

```json
{ "tenancy": { "orm": { "rls": true, "rlsBypassRole": "app" } } }
```

## Database roles

- Connect the application as a role that is neither a superuser nor `BYPASSRLS`: PostgreSQL skips row level security
  for those.
- Set the bypass role to the application's own role when it reads these tables inside `runAcrossTenants()`. A reporting
  tool that connects as another role sees one tenant per `spina.tenant` it sets, and never every tenant, even when it
  sets `spina.tenant_all` itself.
- The bypass role must exist when a statement reads the table: `pg_has_role()` of a role that does not exist fails the
  statement.
- Without a bypass role the all-tenants scope reads no row of these tables. Visit tenants with `forEachTenant()`.
- The migration of `tenant:rls` runs as the owner of the tables: `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` are
  the owner's.

## Migrations, seeds and jobs

Once the policies are on, a statement that runs with no tenant scope reads no row of these tables, and an `UPDATE` or
a `DELETE` changes nothing. Neither reports an error: the run looks successful and did nothing. An `INSERT` is refused.
That includes raw SQL in a later migration, a seed and a background job.

- Run such a migration or seed inside the all-tenants scope as the bypass role (`runAcrossTenants(reason, fn)` around
  the whole run), or connect the migration run as a role with `BYPASSRLS`.
- Enter the scope before the transaction starts. A migration that runs in a transaction cannot enter it from inside
  `up()`: a change of scope inside an open transaction throws `TenantSwitchDenied` (see
  [Transactions](04-transactions.md)).
- Schema changes (`ALTER TABLE`, an index, a constraint) are not rows and are not affected.

## Checking that a table is protected

Nothing checks at boot that the policies are in the database or that the application's role is subject to them.
`@Tenant({ rls: true })` only makes the application send the tenant; the protection is the migration's.

A model with `rls` added after the last `tenant:rls` run has no policy until the command runs again and the new
migration is applied. Until then its model queries are still confined by `TenantScopeMiddleware`, and raw SQL on its
table reads and writes the rows of every tenant, with no error. The same holds for every table when the application
connects as a superuser or a `BYPASSRLS` role.

Two queries show it. The first, for the tables of your models: each must have `relrowsecurity` and
`relforcerowsecurity` true and `tenant_policy` 1.

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'spina_tenant_isolation') AS tenant_policy
FROM pg_class c WHERE c.relname IN ('invoice');
```

The second, run as the application's role: both columns must be false.

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

## What it does not cover

- A session that sets `spina.tenant` itself. The settings are ordinary session values, so row level security catches
  a statement that forgot the tenant, not SQL written to reach another one. Keep SQL injection out as before.
- A table that is no tenant model with `rls`: a junction table without a tenant column, for one. `TRUNCATE` is not
  filtered, and a foreign key or a unique index still tells whether another tenant uses a key.
- A tenant column that is not a text type (see [Generating the policies](#generating-the-policies)).

## Services and extension points

| Name | What it does |
| --- | --- |
| `TenantSessionSettings` | The `ConnectionSessionSettings` that sends `spina.tenant` and `spina.tenant_all` |
| `sendsTenantSettings(driver)` | `true` for a PostgreSQL or PGlite connection that holds a tenant model with `rls`, and for its read replicas |
| `tenantRlsTables()` | The tables, tenant columns and connections `tenant:rls` covers |
| `generateTenantRls(tables, { bypassRole })` | The `up` and `down` statements of those tables |
| `tenantRlsStatements(table, { bypassRole })` | The statements of one table |
| `tenantRlsMigrationSource(output, className, connection)` | The migration file `tenant:rls` writes |
| `TENANT_RLS_SETTINGS`, `TENANT_ISOLATION_POLICY`, `TENANT_OPEN_POLICY` | The setting and policy names |

## Important behaviour

- Inside a tenant scope every statement on such a connection runs in a transaction of its own, and `stream()` pages by
  key instead of reading a server cursor.
- A read replica (`Replicas` of the connection) gets the same settings with every select routed to it; its policies
  arrive by replication.
- `.acrossTenants()` throws `InvalidOperation` on such a connection, inside a tenant scope and with no scope: the
  database is told the scope around the statement. Use `runAcrossTenants(reason, fn)`.
- In a transaction the first statement fixes the scope (see [Transactions](04-transactions.md)).
- Migrating the newest `TenantRls_...` migration down removes the tenant policies of every table it lists, also those an
  older one created. Row level security stays on while another package's policy is on the table.
- `authz:rls`'s down turns row level security off for its tables, the tenant policies included: run `tenant:rls` and
  migrate again afterwards.
- `rls: true` on SQLite, MySQL or MSSQL only turns on the transaction rule.

## Patterns and antipatterns

```ts
// Don't: the database still sees acme, so this throws on a connection with row level security
await runInTenant('acme', () => Invoice.query().acrossTenants('monthly report'));

// Do: leave the tenant scope for the whole block
await runAcrossTenants('monthly report', () => Invoice.query());
```

## Related

- [Tenant models](02-tenant-models.md): the `rls` option.
- [Transactions](04-transactions.md): one scope per transaction.
- `authz:rls` of `@spinajs/authz-orm`: the permissive policies this page's fallback grant steps back for.
