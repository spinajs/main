---
"@spinajs/authz-orm": patch
---

`spinajs authz:compile --check` reports a file it cannot read (a directory, no permission) as `not readable: <error>` instead of `missing`, and `--check --record` is refused like `--live --record` instead of ignoring `--record`. A module missing during the boot's policy compile is warned about by name (it used to be reported as `@spinajs/authz-ir` not installed, whichever module it was).
