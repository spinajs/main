---
"@spinajs/session-provider-dynamodb": patch
---

Security: the warning `restore` logs for a session item whose `Data` does not decode no longer names the session. Before, it printed `Session item <SessionId> has undecodable Data: <decoder message>`: the item's storage key (the `sha256` of the session id in the cookie) and the decoder's message, which can quote the stored `Data` (the JSON parser up to ten characters of it, the reader of a `Map` a whole value). It now prints `A session of <subject> has Data that does not decode; it is treated as signed out`. The same warning in listings and revocations, which read such an item with an empty `Data`, named nothing and now names the subject: `A session of <subject> has Data that does not decode; it is read with an empty Data`. Log text only: what `restore`, the listings and the revocations answer is unchanged.
