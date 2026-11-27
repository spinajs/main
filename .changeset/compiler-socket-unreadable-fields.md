---
"@spinajs/compiler": patch
---

`@SocketAccess(…, { fields: X })` with an `X` the build cannot read (a call, a `let` or `var`, options it cannot follow to an object literal, a spread or a computed key it cannot read written after the last `fields`) is recorded on the command as `fields: 'filter'`. Before, such a command was recorded without `fields`, so the generated client typed its result as the full model while the server may leave fields out. Now the generated client types it `Redacted<T>` (each chunk of a stream), and the AsyncAPI reply of the command is redactable: code that read the result's fields without a guard gets a type error and must narrow. The build notes each such command with `CMP001` "the fields option of @SocketAccess cannot be read (…)". A shorthand `{ fields }` of a `const` is now read too. To keep a result unredacted, write `fields` as a literal or a `const` the build can read.
