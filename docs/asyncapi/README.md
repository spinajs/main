# `@spinajs/asyncapi`

`manifestToAsyncApi(manifest, { title, version, serverUrl?, errorSchemaId? })` turns an `app.manifest.json` into an AsyncAPI 3.0 document that describes the socket commands and events and the queue messages of the app. It is a pure function: no DI, no filesystem, deterministic output.

For the HTTP routes, see [`@spinajs/openapi`](../openapi/README.md).

## Install

```sh
npm install --save-dev @spinajs/asyncapi @spinajs/cli @spinajs/compiler
```

`@spinajs/asyncapi` is an optional peer of `@spinajs/cli`; without it `generate:asyncapi` fails with `install @spinajs/asyncapi to use generate:asyncapi`. `@spinajs/compiler` is needed for `spinajs build`.

## Generate a document

```sh
spinajs build
spinajs generate:asyncapi --title "Notes" --doc-version 1.2.0 --server-url ws://localhost:4557
# AsyncAPI document written to asyncapi.json
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --manifest <path>` | `app.manifest.json` | Manifest to read |
| `-o, --out <path>` | `asyncapi.json` | File to write |
| `--title <title>` | the app name | `info.title` |
| `--doc-version <version>` | `1.0.0` | `info.version` (`--version` belongs to the root command) |
| `--server-url <url>` | none | Adds `servers.default`: the part before `://` becomes `protocol`, the rest `host` |

A socket controller served only by a registration (a manifest entry with `mountedBy`) is left out.

### Sample output

The `app-basic` fixture has a `ChatSocketController` with a `send` command and a stream command `history`, a `message` event, and two queue messages. Its document, with title `app-basic`, version `1.0.0` and `--server-url ws://localhost:4557`, is committed as `packages/asyncapi/test/__snapshots__/app-basic.asyncapi.json`; the test validates it with `@asyncapi/parser` and fails when the output differs. An excerpt:

```json
{
  "asyncapi": "3.0.0",
  "info": { "title": "app-basic", "version": "1.0.0", "x-spinajs-manifest-hash": "a5a3089daee95281268baa5520cc78048e0c79f21ac3ffd9a54b9255cdf88a81" },
  "servers": { "default": { "host": "localhost:4557", "protocol": "ws" } },
  "channels": {
    "queue/SendMailJob": {
      "address": "queue/SendMailJob",
      "messages": { "message": { "$ref": "#/components/messages/SendMailJob" } },
      "x-spinajs-kind": "job",
      "x-spinajs-routing": "queue.routing.SendMailJob"
    },
    "socket/chat/send": {
      "address": "socket/chat/send",
      "messages": {
        "request": { "$ref": "#/components/messages/chat.send.request" },
        "reply": { "$ref": "#/components/messages/chat.send.reply" }
      }
    }
  },
  "operations": {
    "chat.history.receive": {
      "action": "receive",
      "channel": { "$ref": "#/channels/socket~1chat~1history" },
      "messages": [{ "$ref": "#/channels/socket~1chat~1history/messages/reply" }],
      "x-spinajs-stream": true,
      "x-spinajs-stream-frames": ["chunk", "end", "fail"]
    },
    "chat.send.send": {
      "action": "send",
      "channel": { "$ref": "#/channels/socket~1chat~1send" },
      "messages": [{ "$ref": "#/channels/socket~1chat~1send/messages/request" }],
      "x-idempotent": true
    }
  }
}
```

## How the manifest maps to the document

Channels are named after the transport:

| Source | Channel | Operations |
| --- | --- | --- |
| Socket command | `socket/<prefix>/<command>` | `<prefix>.<command>.send` (payload) and `<prefix>.<command>.receive` (reply) |
| Socket event | `socket/<prefix>/events/<event>` | `<prefix>.events.<event>.receive` |
| Queue message | `queue/<className>` | `queue.<className>.send` |

A command channel carries a `request` and a `reply` message; an event channel an `event` message; a queue channel a `message`. Message names are `<prefix>.<command>.request`, `<prefix>.<command>.reply`, `<prefix>.events.<event>` and the class name, and each points at a schema under `components.schemas`.

Queue routing keys come from configuration at runtime, so a queue channel carries `x-spinajs-routing: queue.routing.<className>` pointing at the key that holds the real one, and `x-spinajs-kind` with the message kind (`job` or `event` in the sample).

| Manifest | Extension |
| --- | --- |
| Command marked `stream` | `x-spinajs-stream: true` on its `receive` operation, and `x-spinajs-stream-frames: ['chunk', 'end', 'fail']`. The reply message is one item |
| Command option `idempotent`, `ordered`, `timeoutMs` | `x-idempotent`, `x-ordered`, `x-timeout-ms` on the `send` operation |
| Command `@Access` permissions | `x-authz-permission` on the `send` operation |

Payload schemas are copied into `components.schemas` without `$id`, `$schema` and `x-*` keys.

### Errors

The reply message of a command is its result type. With `errorSchemaId` set to the `$id` of a schema in the manifest, an `error` message is added to every command channel and to its `receive` operation. The CLI does not set it: call `manifestToAsyncApi` from code to describe the error reply.

There is no tag or `@Public` mapping in AsyncAPI output: socket authorization appears only as `x-authz-permission`.

## Library use

```ts
import { readManifest } from '@spinajs/manifest';
import { manifestToAsyncApi } from '@spinajs/asyncapi';

const manifest = await readManifest('app.manifest.json');
const doc = manifestToAsyncApi(manifest, {
  title: 'Notes',
  version: '1.2.0',
  serverUrl: 'wss://notes.example.com',
  errorSchemaId: 'spinajs/app/SocketError',
});
```

`info.x-spinajs-manifest-hash` holds the hash of the manifest, so a committed document can be checked for drift in CI ([A CI recipe](../manifest/diff-and-ci.md#a-ci-recipe)).

## Known limits

- Only socket controllers, their commands and events, and queue messages are described. HTTP routes belong to the OpenAPI document.
- The reply of a stream command is described as one item; the frames are named by the extension, not modelled as messages.

## Related

- [Command reference](../cli/08-command-reference.md#generateasyncapi)
- [Typed contracts](../http-socket-common/06-typed-contracts.md): the TypeScript form of the same socket API.
- [Socket controllers](../http-socket/02-controllers.md)
