---
"@spinajs/orm": patch
---

`@spinajs/orm` has no runtime import cycle any more. `SelectQueryBuilder.populate()` reaches the relation classes through a registry that `relations.ts` fills when it loads, hydrators recognise models through one that `model.ts` fills, and imports used only as types are `import type`. Import the package entry (`@spinajs/orm`), not a single module of it. CI keeps the package at zero cycles with dependency-cruiser's `no-circular` rule and `scripts/check-orm-cycles.mjs`.
