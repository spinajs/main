---
"@spinajs/compiler": patch
"@spinajs/manifest": patch
---

The manifest records `@Idempotent` stacked on one method as the runtime keeps it: one `IdempotencyMiddleware` entry, with the arguments of the top decorator, at the place of the bottom one. Before, a route listed one entry per decorator, and a redeclared inherited route took the bottom decorator's arguments. Rebuild the manifest; its hash changes only for routes that stack the decorator.
