---
"@spinajs/client": minor
---

New `@spinajs/client/codecs` subpath with ready-made format codecs that take the library as an argument and import no package: `luxonCodec(DateTime)` and `luxonDateCodec(DateTime)`, `decimalCodec(Decimal)` for decimal.js and big.js, which encodes with `toFixed()` because the server's `decimal` format rejects the exponent notation of `toJSON()`, and `bigintCodec`. New `docs/client/models.md` documents `--models`: formats, codecs, registered models, unions, the `__proto__` warning and the relation to ORM models. The "Extending generated types" section recommends `fromClass` over `Object.assign` and adds option (d).
