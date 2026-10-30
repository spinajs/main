# `@spinajs/asyncapi`

`manifestToAsyncApi(manifest, { title, version, serverUrl?, errorSchemaId? })` turns an `app.manifest.json` into an AsyncAPI 3.0 document. It is a pure function: no DI, no filesystem, deterministic output.

Channels are named after the transport:

| Source | Channel | Operations |
| --- | --- | --- |
| Socket command | `socket/<prefix>/<command>` | `<prefix>.<command>.send` (payload) and `<prefix>.<command>.receive` (reply) |
| Socket event | `socket/<prefix>/events/<event>` | `<prefix>.events.<event>.receive` |
| Queue message | `queue/<className>` | `queue.<className>.send` |

Queue routing keys come from configuration at runtime, so a queue channel carries `x-spinajs-routing: queue.routing.<className>` pointing at the key that holds the real one.

A command marked `stream` in the manifest gets `x-spinajs-stream: true` on its `receive` operation; the reply message is one item and the frames are `x-spinajs-stream-frames: ['chunk', 'end', 'fail']`. Command options become `x-idempotent`, `x-ordered`, `x-timeout-ms` and `x-authz-permission`.

Payload schemas are copied into `components.schemas` without `$id`, `$schema` and `x-*` keys. With `errorSchemaId`, an `error` reply message is added to every command channel.

CLI: `spinajs generate:asyncapi --manifest app.manifest.json --out asyncapi.json`.
