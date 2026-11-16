---
'@spinajs/compiler': patch
---

JSDoc text in the manifest (route and class docs, schema descriptions and tag values) has LF line endings, so a CRLF checkout of the same source builds the same manifest hash.