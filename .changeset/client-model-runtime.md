---
"@spinajs/client": minor
---

`@spinajs/client/runtime` gains the zero-dependency model runtime: `Codec`, `dateCodec`, `Formats`, `PlainFormats`, `FormatCodecs`, `FormatTypes`, `ModelEntry`, `fromClass`, `ConversionPlan`, `ConversionPlans`, `RoutePlan`, `RoutePlans`, `ModelClientOptions` and `createModelClient(definition, plans, routePlans, options)`. With `formats` or `models` set, replies are decoded by conversion plan into codec values and registered model instances, and arguments are encoded back (model `encode`, else `toJSON`, then codecs) and projected onto closed objects, so fields a model class adds never reach the server. `fromClass` ignores `__proto__`, `constructor` and `prototype` keys. Without `formats` and `models`, `createModelClient` is `createClient`.
