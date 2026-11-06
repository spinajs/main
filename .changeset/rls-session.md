---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-mssql": minor
"@spinajs/authz-orm": minor
---

`ConnectionSessionSettings` (`@spinajs/orm`) gives transaction-local settings to the statements of the current async path. `OrmDriver` applies them right after `BEGIN` through the dialect's `SessionSettingsQueryCompiler` (`SessionSettingsQueryBuilder`), and runs a statement outside a transaction in a `BEGIN … COMMIT` of its own when there are settings, so nothing stays on a pooled connection; without a provider nothing changes. Postgres compiles them to `set_config(name, value, true)`; every other SQL dialect registers `UnsupportedSessionSettingsCompiler`, which throws `NotSupported` before the transaction opens rather than run statements without them. authz-orm's provider, on with `authz.orm.rls.session: true`, sets `spina.subject_keys`, `spina.principal` and `spina.bypass` (`'on'` under SYSTEM only), once per request. `authz:rls --out <dir> [--domain] [--bypass-role]` writes the row level security migration of every `rls` table (`authz.orm.rls.bypassRole` is the default role) and writes nothing on AUTHZ020.
