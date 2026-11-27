---
"@spinajs/templates-puppeteer": patch
---

A failed render no longer logs or reports a URL raw. `Error during rendering` and `Error rendering to file` log a copy of the error whose message, stack and cause chain print every URL they quote without userinfo, query and fragment, and the `failed` progress message does the same. A subclass that calls `page.goto()` therefore no longer leaks a presigned URL or credentials through Puppeteer's `net::ERR_* at <url>`; the operator still sees the error code, host, port and plain path, and a Node error's `code`. The error the render rejects with is the original, unchanged.
