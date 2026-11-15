---
"@spinajs/http": minor
---

`@NoCompression()` mounts the new `NoCompressionMiddleware`: the `Compression` server middleware leaves the replies of that route or controller uncompressed (its `filter` checks a `res.locals` flag, then the `compression` package's default filter).
