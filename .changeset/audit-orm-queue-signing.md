---
"@spinajs/audit-orm": minor
---

`@spinajs/audit-orm/queue`: opt-in signed `AuditBatchRecorded` messages. With `audit.queue.signing: { keyId, secret }` the sink adds `KeyId` and `Sig`, the base64url HMAC-SHA256 of the canonical JSON of `{ trail, source, events }`, to every message; an unsigned message keeps its fields. With `audit.queue.verify: { required?, keys: { <source>: [{ id, secret }] } }` the consumer checks the signature in constant time before it decodes an event, by the key the message names among its source's keys (several for rotation). A message of a source without keys, under an unlisted key id, with a missing or wrong signature, or unsigned under `required: true`, is never archived: one error line on `audit-queue`, then a `PermanentJobFailure` (`audit_signature`). Without `required` an unsigned message is accepted; without `verify` nothing is checked. Secrets are at least 16 characters, key ids at most 64.
