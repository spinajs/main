---
"@spinajs/intl-orm": patch
---

A `clone()` of a select keeps `translated` and `AllowTranslate`, so a clone of a translated query is not translated a second time by `IntlQueryMiddleware` or a repeated `translate()`, and a clone of a query that opted out stays untranslated.
