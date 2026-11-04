---
"@spinajs/orm": minor
"@spinajs/orm-postgres": minor
"@spinajs/authz-orm": minor
---

`ConnectionSessionSettings` (`@spinajs/orm`) gives transaction-local settings to the statements of the current async path. The Postgres driver applies them with `set_config(name, value, true)` right after `BEGIN`, and runs a statement outside a transaction in a `BEGIN … COMMIT` of its own when there are settings, so nothing stays on a pooled connection; without a provider nothing changes. authz-orm's provider, on with `authz.orm.rls.session: true`, sets `spina.subject_keys`, `spina.principal` and `spina.bypass` (`'on'` under SYSTEM only), once per request. `authz:rls --out <dir> [--domain] [--bypass-role]` writes the row level security migration of every `rls` table (`authz.orm.rls.bypassRole` is the default role) and writes nothing on AUTHZ020.
