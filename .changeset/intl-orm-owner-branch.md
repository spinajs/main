---
"@spinajs/intl-orm": patch
---

`IntlModelMiddleware` no longer tests whether its owner is a `BelongsToRelation`: both branches of that test wrote the translated value to the same model. No behaviour change.
