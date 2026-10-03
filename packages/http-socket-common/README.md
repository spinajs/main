# @spinajs/http-socket-common

The wire protocol shared by `@spinajs/http-socket` (server) and `@spinajs/http-socket-client`. It has no dependencies and runs in browsers and Node. Both packages re-export it, so apps rarely import it directly.

- `PROTOCOL_VERSION` (1) and the wire event names `WIRE_EVENTS`:
  - commands: `cmd`
  - events in both directions: `evt`
  - stream frames, server to client: `chunk`, `end`, `fail`
  - client to server: `credit`, `cancel`
- `SYSTEM_EVENTS`: `sys.shutdown`, `sys.disconnect`.
- The envelopes (types):
  - `Handshake`
  - `CommandRequest` (`id`, `name`, `payload`, `deadline`, `traceparent`, and `credits` for streams)
  - `CommandReply`: `CommandResultReply`, `CommandStreamReply` or `CommandErrorReply`
  - `EventFrame`, `ShutdownNotice`, `DisconnectNotice`
  - the stream frames `Chunk`, `StreamEnd`, `StreamFail`, `StreamCredit`, and `CancelFrame`
- Guards for them: `isCommandRequest`, `isEventFrame`, `isCancelFrame`, `isChunk`, `isStreamEnd`, `isStreamFail`, `isStreamCredit`.
- Names and ids: `isName` / `NAME_PATTERN` / `MAX_NAME_LENGTH` and `isId` / `ID_PATTERN` / `MAX_ID_LENGTH`.
- Keys: `isKey` / `MAX_KEY_LENGTH` (the rule for `CommandRequest.idempotencyKey` and `after`, which are reserved for durable commands).
- The 13 error codes:
  - `ErrorCode`, `ERROR_CODES`, `DEFAULT_RETRYABLE`, `isErrorCode`
  - the wire shape `SocketError` and its guard `isSocketError`
  - `SocketException`, a throwable `SocketError` with `toWire()` / `fromWire()`
- Typed contracts: `defineContract<C>()`, `ContractShape`, `SocketContract` and the helper types `CommandName`, `CommandPayload`, `CommandResult`, `EventName`, `EventPayload`, `ClientEventName`, `ClientEventPayload`, `ContractOf`.

See [`@spinajs/http-socket`](../http-socket) for the server, [`@spinajs/http-socket-client`](../http-socket-client) for the client and [`packages/http-socket-example`](../http-socket-example) for a runnable example.
