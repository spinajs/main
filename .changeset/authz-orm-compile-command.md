---
"@spinajs/authz-orm": minor
---

`spinajs authz:compile` boots the app's authz domain and writes its policy IR to `authz.ir.json` (the default input of `authz:verify` and `authz:export`) and prints its policy hash, the one decision records cite. `--check` fails when the file is stale (for CI), `--live` compiles the policy held in database stores too, `--record` stores the policy version.
