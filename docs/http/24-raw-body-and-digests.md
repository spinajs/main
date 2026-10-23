# Raw request bodies and digests

`@RequestStream()` hands an action the raw request body as a stream, optionally capped at a byte limit. `@ContentDigest()` parses the request's RFC 9530 `Content-Digest` header, so the action can check the bytes it reads. Use them for routes that take a file or a blob as the whole body, without multipart and without buffering it.

## How it works

1. No body parser of the default `http.middlewares` reads `application/octet-stream` (or any type other than JSON, urlencoded and XML), so the request stream is still unread when the route runs. `compression()` and `helmet` do not touch it.
2. `RequestStreamArg.extract()` checks that state: a body that a parser already took (the stream is ended, or flowing) answers **415** (`UnsupportedMediaTypeException`).
3. Without `maxBytes` the action gets the request itself. With `maxBytes` it gets `limitRequestStream(req, maxBytes)`: a `PassThrough` fed through `ByteLimitStream(maxBytes)`.
4. When the body goes over `maxBytes`, the stream stops passing bytes on, reads off and discards the rest of the request, and fails with `LimitExceeded` only after the request ended. The action's read rejects; unhandled, the error answers **413**.
5. `ContentDigestArg.extract()` reads `content-digest` (several header lines are joined with `, `), parses it with `parseContentDigest()`, and gives the action a `Map<string, Buffer>` keyed by the lower-cased algorithm (`sha-256`). A malformed header answers **400**.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@RequestStream(options?)` | parameter | `{ maxBytes?: number }`: a non-negative safe integer, checked when the class is declared (`InvalidArgument` otherwise) | The raw body as a `NodeJS.ReadableStream`; `415` when a parser took it. Type `RequestStreamArg`. |
| `@ContentDigest(options?)` | parameter | `{ required?: boolean; algorithms?: string[] }` | `Map<algorithm, digest bytes>`; an empty map when the header is absent and not `required`. `400` when it is absent and `required`, malformed, or (with `algorithms`) carries none of the listed algorithms. Other algorithms are dropped from the map. Type `ContentDigestArg`. |

`parseContentDigest(header: string): Map<string, Buffer>` is exported for other uses, for example a `Repr-Digest` header; it throws `InvalidArgument` (`400` in a route) on a malformed field. `limitRequestStream(req, maxBytes)` is exported too.

## Configuration

Neither decorator has configuration of its own. They depend on:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.middlewares` | `express.RequestHandler[]` | JSON, urlencoded and XML-text parsers | | A body these take arrives empty: `@RequestStream()` answers `415`. |
| `http.bodyLimits` | `{ path, limit }[]` | `[]` | | Refuses a declared `Content-Length` over the limit with `413` before routing, for any content type. See [Body size limits](04-route-arguments.md#body-size-limits). |

## `Content-Digest` parsing

`parseContentDigest` reads an RFC 8941 Dictionary whose members are Byte Sequences, as RFC 9530 defines the field. It differs from the RFCs on purpose in these points:

| Input | RFC 8941 | `parseContentDigest` |
| --- | --- | --- |
| A repeated key (`sha-256=:a:, sha-256=:b:`) | the last one wins | refused: two values for one algorithm are ambiguous for an integrity check |
| An upper-case key (`SHA-256=:…:`) | a parse error | accepted and lower-cased |
| Parameters (`sha-256=:…:;x=1`) | kept | parsed, then dropped; RFC 9530 defines none |

Followed as written:

- Whitespace: leading and trailing spaces and tabs, and spaces around commas, are allowed; none before `=` or `;`.
- A member without a value, or with a value that is not a Byte Sequence (`sha-256=abc`), is refused, as RFC 9530 requires Byte Sequences.
- Base64 must use the standard alphabet; missing `=` padding is accepted, as RFC 8941 §4.2.7 asks.
- A trailing comma is refused. An empty header gives an empty map.
- Algorithm names are not checked against a registry: use the `algorithms` option to restrict them.
- Error messages name the position, never the header text, because the error is logged.

## Error mapping

| Error | Status | Response |
| --- | --- | --- |
| `UnsupportedMediaTypeException` (`@spinajs/http`) | 415 | `UnsupportedMediaType` |
| `LimitExceeded` (`@spinajs/exceptions`) | 413 | `EntityTooLarge` |
| `InvalidArgument`, `BadRequest` | 400 | `BadRequestResponse` |

`LimitExceeded` maps to `413` everywhere, not only on these routes: any `LimitExceeded` an action lets through answers `413`.

## Important behaviour

- **The action must read or close the stream.** Destroying the stream returned for `maxBytes` unpipes the request and reads the rest of it off, so an early answer still reaches the client. Leaving the request unread and answering resets the client's connection while it is still sending.
- **A body over `maxBytes` is read to its end before the `413`.** A client can keep sending until Node's `server.requestTimeout` (300 s by default) ends the request. Pair the route with `http.bodyLimits`, which refuses a declared `Content-Length` before reading.
- **An early answer resets the client.** Any answer sent while the body is still arriving (a policy refusal, a 413 from `http.bodyLimits`) can reach the client as `ECONNRESET` instead of the response. Read the body off first, or close the connection.
- **One raw body per route.** The request has one body: do not combine `@RequestStream()` with `@Body()`, `@File()` or a second `@RequestStream()`. [`@spinajs/http-swagger`](../http-swagger/03-parameters-and-request-bodies.md#custom-route-arg-types) refuses such a route.
- **`@ContentDigest()` does not hash the body.** It only parses the header; compare it with your own `DigestStream` of the bytes you read.
- **A client abort** destroys the request; the limited stream then fails with the request's error, or `IOFail` (`request closed before its body ended`).
- **An error nobody reads does not crash the process.** The stream returned for `maxBytes` has its own no-op `error` listener, so an error that arrives before the action reads (a client abort, an early `LimitExceeded`) is ignored. A reader that attaches later still gets the error: iterating or piping the destroyed stream rejects with it.

## Best practices

- Always set `maxBytes`: without it the action gets the whole request, of any size.
- Ask clients for `Content-Type: application/octet-stream`: every other type risks a parser taking the body.
- Use `@ContentDigest({ required: true, algorithms: ['sha-256'] })` when the route must verify integrity, so a client cannot send only an algorithm you do not check.

## Examples

### Store a database backup with an integrity check

```ts sample
import { BadRequest, ResourceDuplicated } from '@spinajs/exceptions';
import { DigestStream, getFs } from '@spinajs/fs';
import { BaseController, BasePath, ContentDigest, Ok, Param, Put, RequestStream } from '@spinajs/http';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BACKUP = 512 * 1024 * 1024;

// 'close' means stored on every provider; on fs-s3 a refused write fails with 'error', possibly after 'finish'
const closed = (out: Writable) =>
  new Promise<void>((resolve, reject) => {
    out.once('close', () => resolve());
    out.once('error', reject);
  });

/** PUT /backups/2026-10-23.sql.gz with Content-Digest: sha-256=:<base64>: */
@BasePath('backups')
export class BackupsController extends BaseController {
  @Put(':name')
  public async store(
    @Param() name: string,
    @RequestStream({ maxBytes: MAX_BACKUP }) body: NodeJS.ReadableStream,
    @ContentDigest({ required: true, algorithms: ['sha-256'] }) digest: Map<string, Buffer>,
  ) {
    const backups = getFs('backups');
    const key = `incoming/${name}`;
    const hash = new DigestStream('sha256');

    let out: Writable;
    try {
      out = await backups.writeStream(key, { exclusive: true, contentType: 'application/gzip' });
    } catch (err) {
      // fsNative refuses an existing key here; destroying the body reads the rest off, so the 409 reaches the client
      (body as Readable).destroy();
      throw err;
    }

    const done = closed(out);
    done.catch(() => undefined);
    try {
      await pipeline(body, hash, out);
      await done;
    } catch (err) {
      // the key belongs to someone else when the exclusive write was refused
      if (!(err instanceof ResourceDuplicated)) await backups.rm(key);
      throw err;
    }

    if (hash.digest('base64') !== digest.get('sha-256')!.toString('base64')) {
      await backups.rm(key);
      throw new BadRequest('the body does not match its Content-Digest');
    }
    return new Ok({ name, bytes: hash.bytes });
  }
}
```

The route answers `413` for a body over 512 MiB, `415` for a JSON body, `409` when the backup already exists (`ResourceDuplicated` from the exclusive write) and `400` for a missing, malformed or wrong digest.

## Related

- [Route arguments](04-route-arguments.md): the other parameter decorators and body limits.
- [Streams](../fs/12-streams.md): `DigestStream` and `ByteLimitStream`.
- [Wire protocol](../upload/01-protocol.md): `@spinajs/upload`'s part route, built on both decorators.
