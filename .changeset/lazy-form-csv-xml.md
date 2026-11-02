---
"@spinajs/http": patch
---

`formidable`, `csv` and `fast-xml-parser` load on first use, not when `@spinajs/http` is imported: the first multipart form or file upload loads formidable, the first `@CsvFile()` argument loads csv, and the first XML request body or XML response loads fast-xml-parser. An XML response's `execute` (`new Xml()`, or any response when `http.AcceptHeaders` offers XML) loads the builder before it returns the response function, so that function still sends synchronously; a function from `xmlResponse()` called directly sends once the builder is loaded. A test boots a require-mode app and fails if any of these modules, or pug, archiver or unzipper, is loaded at boot.
