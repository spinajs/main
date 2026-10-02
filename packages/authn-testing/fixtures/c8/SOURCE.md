# Canvas C8 golden tickets

Vendored test fixtures for N7 (`authn-keys`, A17). Do not edit by hand.

- Repo: `https://gitlab.coderush.pl/coderush/canvas.git`
- Branch: `foundation/f06-c8-plane-api`
- Copied from head: `5157a618802c9702f8baa5fbb4b010a8550b3339`
- Files last changed in: `27eb8cf069f6a95a13771dcf7d39d5ebc10f56f5`
- Copied on: 2026-10-02

| Source path | Vendored path | Size | Git blob | sha256 |
|---|---|---|---|---|
| `fixtures/plane-api/keys.json` | `keys.json` | 729 | `df27eb967c5451c6b47f6f2d77a41927ed124905` | `a4477d2c38a4a36bdcbd440632e30c4863ff07e95dfae7c0825a5e102c1becb3` |
| `fixtures/plane-api/tickets.json` | `tickets.json` | 34799 | `81b5baac68736838a1f22180e94901f7c19994e9` | `907762fafaf8e893ac2225aec370892266fb91d0069212dea18d86ba49bd30d4` |

The keys are public test keys (RFC 8037 A.1 and RFC 8032 section 7.1
TEST 2). Never use them outside tests.

`.gitattributes` keeps Git from converting line endings; the loader
refuses a copy whose sha256 differs.

To refresh: copy both files again with `git show <sha>:<path>`, then
update the hashes and sizes here and in `C8_SOURCE`
(`src/fixtures/c8.ts`).
