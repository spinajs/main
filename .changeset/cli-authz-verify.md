---
"@spinajs/cli": minor
---

`spinajs authz:verify` checks an app's authorization assertions against its policy IR: `--ir <path>` (canonical `PolicyIR` JSON, default `authz.ir.json`), `-a, --assertions <path>` (a module whose default export is `defineAssertions(...)`, default `authz.assertions.js`), `-f, --format text|json|github`, `-k, --bound <k>` (objects per type for the bounded engine, default 3), `--require-solver` (a missing `z3-solver` is an error) and `--fail-on warning|error`. Output has the `doctor` shapes; a violated assertion prints its counterexample and sets exit code 1. `@spinajs/authz-verify` is a new optional peer dependency, loaded only by this command.
