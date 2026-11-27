---
"@spinajs/templates-puppeteer": patch
---

The page log lines no longer print an asset URL raw. A response (`trace`) and a failed request (`error`) show the URL without userinfo, query and fragment, with a path segment that may be a token masked as `***`; a failed request keeps Chromium's error text. A page error is logged as its class and message, without the stack, and the URL its message quotes is redacted the same way, so a presigned asset (`X-Amz-Signature=…`, `?token=…`) in a template never reaches the log.
