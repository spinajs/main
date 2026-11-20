---
"@spinajs/authz-orm": minor
---

Policy versions at boot (Bet 6 L2 wiring). `IRPolicyHashSource` is the registered `PolicyHashSource`: when a domain with a decision log boots, it compiles the domain's config policy IR (`compileDomainPolicy`, DB-stored policy as `stored:` placeholders), so its decision records carry that `policyHash` instead of `'unknown'`, and stores the IR in `authz_policy_version` once per hash from every node, in the background with retries. A process whose authz store is unreachable (no `authz` connection, no table) logs one warning and only cites hashes. `authz.changelog.policyVersion` (new): `'record'` (default), `'hash'` (cite without storing) or `'off'`. Domains without a decision log are not compiled.
