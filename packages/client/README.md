# @spinajs/client

Typed HTTP client for SpinaJS applications. The runtime (`@spinajs/client/runtime`) is browser-safe: `createClient(definition, options)` turns a route table into typed fetch calls, throws `ProblemError` on `application/problem+json` replies and serialises query strings flat, as the server's Express 5 `simple` parser reads them.

## Options

`createClient(definition, options)` and the generated `createAppClient(options)` take:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | required | Prefix of every request; trailing slashes are removed |
| `fetch` | `globalThis.fetch` | Any fetch-compatible function |
| `headers` | none | `() => Record<string, string>` (or a promise of it), called before every request |
| `credentials` | not set | Passed to `fetch`; `include` sends cookies in a browser |
| `onProblem` | none | Called with the problem document before `ProblemError` is thrown |

A non-2xx reply rejects with `ProblemError` (`status`, `problem`). The generated file is build output: never edit it. To add behaviour to the DTOs, merge a class with the generated interface, wrap the client, or use plain functions; see [Extending generated types](../../docs/client/README.md#extending-generated-types).
