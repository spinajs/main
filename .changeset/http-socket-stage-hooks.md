---
"@spinajs/http-socket": minor
---

Command stages get generic hooks. `SocketCommandStage.onRegister?(handler, registration)` runs once per command when the registry builds, in `Order`, before socket.io attaches; a throw fails the build with an `InvalidOperation` naming the stage and the command. `registration.refuseStream(what)` refuses an async-generator handler at registration and an async-iterable result at run time (`handler.streamRefusal`, the highest `Order`'s word). The command context gains `handlerStarted`, `drainGrace` (spared by the shutdown drain's first abort once the handler started) and outcome recorders (`addOutcomeRecorder`, `recordOutcome`, `detachOutcome`).

An abort before the handler started now stops the chain at its next step: `next()` rejects with the new `SocketClientGone` (`beforeHandler: true`), a `SocketException` with the abort reason's code and message, so the client's answer is unchanged, and no later stage or handler runs. After the handler started, `next()` still settles with the handler's real outcome. A second `next()` call from one stage rejects with `internal` `next() called twice by <Stage>`.
