---
"@spinajs/cli": patch
---

`generate:client` prints the diagnostics of the generated files to stderr. With `--zod-unsupported error` and a zod diagnostic it writes and checks nothing, prints a summary line and exits with code 1, as documented.
