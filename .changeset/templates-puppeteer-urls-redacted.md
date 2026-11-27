---
"@spinajs/templates-puppeteer": patch
---

The page log lines no longer print a URL raw. A response (`trace`) and a failed request (`error`) show the URL without userinfo, query and fragment, with a path segment that may be a token masked as `***`; a failed request keeps Chromium's error text. Console lines (`trace`) and page errors (`error`: class and message, the stack in `stack`) print every URL they quote the same way, a stack frame keeping its line and column, so a presigned asset (`X-Amz-Signature=…`, `?token=…`) in a template never reaches the log.
