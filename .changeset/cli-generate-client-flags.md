---
"@spinajs/cli": minor
"@spinajs/client": minor
---

`spinajs generate:client` writes every file `generateClientFiles` returns and accepts `--hooks`, `--zod` (with `--zod-mini`, `--zod-replies`, `--zod-unsupported`), `--models`, `--socket-hooks`, `--key-prefix`, `--server`, `--next`, `--mocks` and `--msw`. A flag whose generator is not part of the installed `@spinajs/client` fails with "not available in this version" before anything is written. `--check` writes nothing and exits 1, naming each generated file that is missing or differs from disk, which replaces `git diff --exit-code` in CI. `@spinajs/client` gains the `server`, `next`, `mocks`, `msw` and `zod.replies` options and the matching `GENERATOR_TARGETS` entries. Without the new flags the output is unchanged.
