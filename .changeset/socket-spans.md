---
"@spinajs/http-socket": major
"@spinajs/http-socket-client": minor
---

Every socket command runs under a SERVER span `socket <command>` (`_OTHER` for an unknown name) that continues the request's `traceparent`; the call storage ids are the span's. Breaking for subclasses of `SocketDispatcher`: `callStorage(connection, call, requestId, ids)` takes the command span's `TraceIds` where it took a `traceparent` string, and `createContext` starts the span. `TraceIds` is exported by `@spinajs/tracing`; an override that read the raw `traceparent` in `callStorage` reads `request.traceparent` in a `createContext` override instead. The client sends the active span as `traceparent` when the caller passes none, through `@opentelemetry/api`, a new runtime dependency (no-op without a registered propagator).
