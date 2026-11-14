---
"@spinajs/authz-ir": minor
"@spinajs/cli": minor
---

`readOpenFga(dsl)` reads an OpenFGA model (schema 1.1) into the policy IR, restoring everything `writeOpenFga` put in `# spina:` comments, so an export reads back to the same IR. `irToRebacConfig(ir)` turns it into `authz.rebac` namespaces and permissions and lists what ReBAC cannot hold. New CLI commands `spinajs authz:export --ir <file> [--strict]` and `spinajs authz:import <model.fga> [--out] [--strict]`; `@spinajs/authz-ir` is their optional peer.
