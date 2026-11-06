---
"@spinajs/authz-orm": minor
---

`recordPolicyVersion(policyHash, irJson)` stores the policy IR under its sha256 hash in `authz_policy_version` unless the hash is known (returns whether it was new; `first_seen_at` keeps the first instant), and `readPolicyVersion(policyHash)` reads it back verbatim, for replay. Nothing calls it at boot yet: the running policy hash comes with the IR package. `@spinajs/authz-orm/scheduler` adds `ChangeLogRetentionTask` (schedule `authz.changelog.retention`, daily, leader only), which deletes `authz_change_log` rows older than `authz.changelog.retentionDays` (new config key, default 400); `pruneChangeLog(days?, now?)` does the same on demand. `@spinajs/scheduler` is an optional peer.
