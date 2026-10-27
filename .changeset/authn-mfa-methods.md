---
"@spinajs/di": major
---

`@spinajs/authn` no longer ships `authn.mfa.policy.methods`; the schema default (`['password']`) applies when an app sets none. Config arrays concatenate, so the shipped value made `password` impossible to remove: an app that sets `methods` now gets exactly its list. An app that relied on `password` being added must list it.
