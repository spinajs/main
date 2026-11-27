---
"@spinajs/session-provider-redis": patch
---

Security: the store's log lines and its error about a stored session value no longer name the session. Before, they printed the session's storage key (the `sha256` of the session id in the cookie): `restore` threw `Session <SessionId> is not a JSON object`, and listings, revocations, `save`, `delete` and `touch` warned `Unreadable value of session <SessionId> skipped` and `Session <SessionId> has undecodable Data, read without its Data`. They now read `A stored session value is not a JSON object` (thrown), `A stored session value is not a JSON object; it is skipped` and `A session of <subject> has Data that does not decode; it is read with an empty Data`. Text only: what `restore`, the listings, `touch` and the revocations answer or throw is unchanged.
