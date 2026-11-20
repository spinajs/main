---
"@spinajs/authz-orm": patch
---

`spinajs authz:compile --check` reports a file it cannot read (a directory, no permission) as `not readable: <error>` instead of `missing`, and `--check --record` is refused like `--live --record` instead of ignoring `--record`. The warning that `@spinajs/authz-ir` is not installed carries the error, which names the module that was not found.
