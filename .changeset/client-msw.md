---
"@spinajs/client": minor
---

`generateClientFiles({ mocks: true, msw: true })` writes `client.msw.ts`: `createAppHandlers(baseUrl, overrides?)` returns one MSW `RequestHandler` per route, answering with the data of `client.mocks.ts` (a route with no reply answers 204), and `AppHandlerOverrides`, keyed `controller.handler`, types an override's reply by the route. Express 5 paths are translated to MSW's syntax: an optional group becomes one handler per combination and `*name` becomes `*`. `msw` without `mocks` throws. `client.msw.ts` is the only generated file that imports `msw`, and it carries no `'use client'` directive. `msw` is an optional peer dependency, `^3.0.0` (verified against 3.0.3, Node `>=22.12.0`). `RouteModel` gains `fullPath`, and `emitMsw` and `mswPaths` are exported.
