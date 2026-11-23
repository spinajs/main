---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
---

`@Bool({ nullable: true })` keeps NULL: `null` is written as NULL and read back as `null`, for a `boolean | null` property over a nullable column. Without the option NULL still reads as `false` and `null` writes as `0`. New export `IBoolConverterOptions`.
