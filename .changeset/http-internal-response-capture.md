---
"@spinajs/http": major
---

The response capture is internal. `ResponseCapture`, `attachResponseCapture` and `REPLAYED_HEADERS` are no longer exported from `@spinajs/http`; they were added during 4.0 development and never shipped in a 3.x release. To read or change a reply, use a middleware's `onAfter(ctx)` (`ctx.response.data`, `ctx.response.statusCode`, `ctx.response.setHeader()`); to observe the reply that was sent, read the `reply` of the `IRouteOutcome` that an `onAround`'s `proceed()` resolves with. `CapturedJsonReply` stays exported as a type, the type of `IRouteOutcome.reply`.
