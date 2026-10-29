---
"@spinajs/authn": major
---

`@spinajs/authn` no longer ships `authn.mfa.policy.methods`; the schema default (`['password']`) applies when an app sets none. Config arrays concatenate, so the shipped value made `password` impossible to remove: an app that sets `methods` now gets exactly its list. A configured `methods` list replaces the default, so an app that sets `methods` without `password` (for example `['oidc']`) no longer requires an MFA step for password logins. Write `['password', 'oidc']`. `forceForRoles` is no longer shipped either (schema default `[]`), so a malformed string value is now refused instead of being concatenated into a list.
