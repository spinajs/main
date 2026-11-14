---
"@spinajs/http": minor
---

`@SlowThreshold(ms)` on a route or controller replaces `http.slowRequest.thresholdMs` for its requests: the new `SlowThresholdMiddleware` puts `ms` on `req.storage.slowThresholdMs`, which `SlowRequestWarning` judges the request against. `Infinity` never warns.
