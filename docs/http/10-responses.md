# Responses

An action returns a `Response` object; the framework turns it into the HTTP answer. Most response classes pick the format from the request's `Accept` header (JSON, HTML from a pug template, XML or text) and set their own status code. `Json` and `Xml` always answer in one format; `FileResponse` sends a file as a download or inline, with byte ranges; `ZipResponse` and `JsonFileResponse` send a download; `TemplateResponse` renders a page; `Redirect` redirects.

## How it works

1. The action returns a `Response`, or a `Promise` of one. The action handler stores it in `res.locals.response`.
2. The response handler (`__handle_response__`, the step after the action and its `onAfter` middlewares) calls `response.execute(req, res)`.
   - Nothing stored (the action returned `undefined` or `null`): it raises `ResourceNotFound`, answered as 404.
3. `Response.execute()` awaits the data (`prepareResponse()`: a `Promise` is awaited; an array of promises is awaited with `Promise.all`).
4. It calls `httpResponse(data, this._template, { ...options, StatusCode: options.StatusCode ?? this._errorCode })`, which returns a function `(req, res) => void`; the response handler calls it.
5. A thrown error or rejected promise goes to the [error handler](11-error-handling.md).

### Content negotiation

`httpResponse(model, template, options)`:

1. Offers the formats enabled in `http.AcceptHeaders`, in this order: `json`, `html`, `xml`. JSON comes first so `*/*` or a missing `Accept` gets JSON.
2. Picks the best with `req.accepts(offered)`, which honours the client's order and `q` values.
3. **HTML**: downloads `template` from the `__fs_http_response_templates__` provider and renders it with `Templates` (pug), the data as the model. A missing template or a render error renders `serverError.pug` with status 500; when that fails too, it sends `http.FatalTemplate` with a random 7-character ticket.
4. **JSON**:
   - status 400 or above: runs the error [data transformer](12-data-transformers.md) named in `x-error-transform` (default `default-http-error-transform`);
   - an `x-data-transform` header: runs that data transformer;
   - otherwise `res.json(data)`.
5. **XML**: serializes with `fast-xml-parser`'s `XMLBuilder`; arrays and scalars are wrapped in `<response>`.
6. None of those, but the client accepts `text/plain`: sends `JSON.stringify(data)` as `text/plain`.
7. Otherwise: 406 with `{ error: { message: 'Not Acceptable', code: 406 } }` in JSON.

Every format applies `options.Headers` and `options.Coockies` (see [Cookies](20-cookies.md)) before writing the body.

## Response classes

| Class | Status | Template | Mapped exceptions (thrown → this response) | Notes |
| --- | --- | --- | --- | --- |
| `Ok` | 200 | `ok.pug` | | |
| `Created` | 201 | `created.pug` | | |
| `NoContent` | 204 | `noContent.pug` | | Pass `null`: `new NoContent(null)`. |
| `BadRequestResponse` | 400 | `badRequest.pug` | `InvalidArgument`, `BadRequest`, `JsonValidationFailed` | |
| `ValidationError` | 400 | `validationError.pug` | `ValidationFailed` (`@spinajs/validation`) | |
| `Unauthorized` | 401 | `unauthorized.pug` | `AuthenticationFailed` | |
| `ForbiddenResponse` | 403 | `forbidden.pug` | `Forbidden` | |
| `NotFound` | 404 | `notFound.pug` | `ResourceNotFound` | |
| `NotAllowed` | 405 | `not-allowed.pug` | | |
| `NotAcceptable` | 406 | `not-acceptable.pug` | `ExpectedResponseUnacceptable` | |
| `Conflict` | 409 | `conflict.pug` | `ResourceDuplicated` | |
| `EntityTooLarge` | 413 | `entityTooLarge.pug` | `EntityTooLargeException`, `LimitExceeded` (`@spinajs/exceptions`) | Every `LimitExceeded` an action lets through answers 413, on any route. |
| `UnsupportedMediaType` | 415 | `unsupported-media-type.pug` | `UnsupportedMediaTypeException` | Thrown by `@RequestStream()` when a parser took the body. |
| `TooManyRequests` | 429 | `too-many-requests.pug` | | Options also take `retryAfterSeconds`, sent as `Retry-After` (rounded up, see `retryAfterHeader` in [Header and cookie helpers](22-header-and-cookie-helpers.md)) when it is a finite number. |
| `ServerError` | 500 | `serverError.pug` | `MethodNotImplemented`, `IOFail`, `UnexpectedServerError`, and every unmapped error | |
| `CodedHttpExceptionResponse` | the exception's `status` | none | `CodedHttpException` (defined in `@spinajs/exceptions`, re-exported by `@spinajs/http`) | Always JSON `{ code, message, details? }`, never a stack. See [Coded errors](11-error-handling.md#coded-errors). |
| `Json` | 200 or `options.StatusCode` | none | | Always JSON. |
| `Xml` | 200 or `options.StatusCode` | none | | Always XML. Third argument: `XMLBuilder` options. |
| `TemplateResponse` | 200 or `options.StatusCode` | the given file | | Renders `file` from the `__fs_http_templates__` provider, or `{ template, provider }` from another provider. Throws `IOFail` when the provider is missing. |
| `FileResponse` | 200, 206, 304, 412 or 416 | none | | Sends a file from a provider (default `local`) as an attachment or inline. See [File responses](#file-responses). |
| `ZipResponse` | 200 | none | | Zips a file from a provider and sends the archive; the archive is deleted afterwards. |
| `JsonFileResponse` | 200 | none | | Writes `data` as JSON to the `fs-temp` provider and sends it as an attachment named `filename`. |
| `Redirect` | 302 or the given status | none | | `new Redirect(url, status?, responseOptions?)`. |

Every class except `Redirect`, `FileResponse`, `ZipResponse`, `JsonFileResponse` and `TemplateResponse` takes `(data, options?: IResponseOptions)`.

`IResponseOptions`:

| Field | Type | Meaning |
| --- | --- | --- |
| `StatusCode` | `HTTP_STATUS_CODE` | Overrides the class status. |
| `Headers` | `{ Name, Value }[]` | Response headers. |
| `Coockies` | `{ Name, Value, Options }[]` | Cookies; note the spelling. `Options.signed: true` signs with `http.cookie.secret`. |

`IFileResponseOptions` (`FileResponse`, `ZipResponse`):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | `string` | | Path inside the provider. |
| `filename` | `string` | last segment of `path` (`ZipResponse`: with `.zip` added) | Name sent as `Content-Disposition: <disposition>; filename*=UTF-8''...`. An inline `FileResponse` without one sends a bare `Content-Disposition: inline`. |
| `provider` | `string` | `'local'` | File provider name. |
| `mimeType` | `string` | from the file extension (`FileResponse`), `application/zip` (`ZipResponse`) | `Content-Type`. |
| `deleteAfterDownload` | `boolean` | `false` | `FileResponse` removes the source file after any answer, a 206 or 304 too. |
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | `FileResponse` only; the options type of `ZipResponse` leaves it out. `inline` lets the browser display the file and adds `X-Content-Type-Options: nosniff`. |
| `headers` | `Record<string, string \| number \| readonly string[]>` | | `FileResponse` only; the options type of `ZipResponse` leaves it out. Headers of the file answer (200, 206, 304, HEAD), such as `Cache-Control` or `Content-Security-Policy`. An error answer never carries them. |

## File responses

`FileResponse` checks the file on its provider, then sends it with Express' `res.sendFile` (the `send` module). For a remote provider it downloads a temporary copy and deletes it after sending; a local file is sent in place.

1. `getFs(provider)`: a missing provider throws `IOFail` (500).
2. `provider.exists(path)`: `false` throws `ResourceNotFound` (404).
3. `provider.download(path)`: the local path of the file.
4. A `Range: bytes=-N` with `N` at least the file size becomes `bytes=0-`, the whole file (RFC 9110 §14.1.2), and `Range: bytes=-` is dropped. `send` would answer both with 416.
5. `IResponseOptions.Headers` and `Coockies` are set. They stay on every answer, an error too.
6. `res.sendFile` finds the file, then sets the file headers: `X-Content-Type-Options: nosniff` (inline), then `headers`, then `Content-Type` from `mimeType`, then `Content-Disposition`. A later one wins over an earlier one with the same name, and over a value a middleware or step 5 set.
7. `send` adds `Accept-Ranges: bytes`, a weak `ETag` (`W/"<size>-<mtime>"`), `Last-Modified`, `Cache-Control: public, max-age=0` when no `Cache-Control` is set, and `Content-Type` from the extension when none is set (text types with `charset=utf-8`; unknown extensions `application/octet-stream`).
8. It answers the request as in the table below. A failure before the body starts puts the headers back as they were before step 6: it removes those steps 6 and 7 added, and gives back a value they replaced, such as a middleware's `Cache-Control`.

| Request | Answer |
| --- | --- |
| No `Range` | 200 with the whole file. |
| `Range: bytes=0-1023`, `bytes=1024-`, `bytes=-500` | 206 with `Content-Range: bytes <first>-<last>/<size>` and that part only. A last byte past the end is cut to the end. |
| `bytes=-N` with `N` at least the file size | 206 with the whole file, `Content-Range: bytes 0-<size - 1>/<size>`. |
| `bytes=-` | 200 with the whole file. |
| Several ranges | One 206 when they overlap or touch (`bytes=0-9,10-19`); otherwise 200 with the whole file. Unusable ranges in the list are dropped (`bytes=0-1,abc` answers `0-1`). |
| A `Range` in another unit (`items=0-9`) | 200 with the whole file. |
| A `bytes=` range with no usable part: reversed (`bytes=5-2`), malformed (`bytes=abc`), `bytes=-0`, or starting past the end | 416 with `Content-Range: bytes */<size>` and no body. |
| `If-Range` with an ETag or a date, and `Range` | 206 when it matches the current `ETag`, or is not older than `Last-Modified`; else 200 with the whole file. `send` matches the ETag by its text, so the weak `ETag` it sends matches too, although RFC 9110 asks for a strong one. |
| `If-None-Match` or `If-Modified-Since` that matches | 304 with no body. A request with `Cache-Control: no-cache` gets the whole file instead. |
| `If-Match` or `If-Unmodified-Since` that fails | 412 with no body. |
| `HEAD` | The headers of the `GET` answer (200 or 206), no body. |
| The file is gone when it is sent, or `path` is a directory | `ResourceNotFound` (404), without the file headers. |
| Any other failure before the body, such as a read error (`EACCES`, `EMFILE`) | `IOFail` (500). The body carries none of the fields of the fs error (`path`, `syscall`, `errno`); the error is its `inner`. |
| The client hangs up | Nothing more is sent; the action does not fail. |
| A read error after the headers went out | The connection is closed and a warning is logged on the `http` logger. |

### Serve viewer tiles inline

```ts sample
import { BaseController, BasePath, FileResponse, Get, Param } from '@spinajs/http';

const TILE_HEADERS = {
  // no-transform keeps the compression middleware off, so a 206 carries the bytes on disk.
  'Cache-Control': 'private, no-transform',
  // Tiles come from parsers fed untrusted files: an SVG opened on its own runs no script.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

@BasePath('plans')
export class PlanTilesController extends BaseController {
  /** GET /plans/42/tiles/floor-1.svg, Range requests included. */
  @Get(':plan/tiles/:tile')
  public tile(@Param() plan: string, @Param() tile: string) {
    return new FileResponse({
      provider: 'plan-tiles',
      path: `${plan}/${tile}`,
      filename: tile,
      disposition: 'inline',
      headers: TILE_HEADERS,
    });
  }
}
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.AcceptHeaders` | `HttpAcceptHeaders` | `1 \| 2` | bit flags: `JSON` 1, `HTML` 2, `XML` 4 | Formats negotiation may pick. Add 4 to answer `Accept: application/xml` with XML. |
| `http.FatalTemplate` | `string` | built-in page | HTML with `{ticket}` | Last-resort HTML when the error page itself fails. |
| `fs.providers` `__fs_http_response_templates__` | provider | `<package>/lib/views/responses` | any provider | Templates for the negotiated HTML answers. Point it at your own directory to restyle them; keep every file name. |
| `fs.providers` `__fs_http_templates__` | provider | not set | any provider | Templates for `TemplateResponse`. |
| `fs.providers` `local`, `fs-temp` | provider | from `@spinajs/fs` | | Default providers of `FileResponse`/`ZipResponse` and `JsonFileResponse`. |

```ts
export default {
  fs: {
    providers: [
      { service: 'fsNative', name: '__fs_http_templates__', basePath: '/app/views' },
      { service: 'fsNative', name: '__fs_http_response_templates__', basePath: '/app/views/responses' },
    ],
  },
  http: {
    AcceptHeaders: 1 | 2 | 4,
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Response` (abstract) | No token: created with `new` by actions and by the error handler | the classes above | `OrmNotFound` (`@spinajs/orm-http`), `PrometheusResponse` and `ServiceUnavailable` (`@spinajs/telemetry`), `OidcResponse` (`@spinajs/authn-oidc`) | Extend `Response` (or `BadRequestResponse` for an error), set `_errorCode` and `_template`, or override `execute()` for full control. |
| Error response for an exception | `'__http_error_map__'` | see the table | | `@HandleException`; see [Error handling](11-error-handling.md). |
| `Templates` | `@spinajs/templates`, resolved by `HttpServer` | pug from `@spinajs/templates-pug` | | See [`@spinajs/templates`](../templates/README.md). |

Members you use when extending `Response`:

| Member | Meaning |
| --- | --- |
| `protected _errorCode: number` | Default status. |
| `protected _template: string` | Template name in `__fs_http_response_templates__` for HTML clients. |
| `protected responseData`, `protected options` | Constructor arguments. |
| `prepareResponse()` | Awaits the data. |
| `execute(req, res, next?)` | Returns a `(req, res) => void` or writes the answer itself and returns nothing. |

### `Response`: custom implementation

A negotiated response only needs a status and a template; it gets JSON, HTML and XML for free:

```ts sample
import { BaseController, BasePath, HTTP_STATUS_CODE, IResponseOptions, Ok, Param, Post, Response } from '@spinajs/http';

/** 202 Accepted with a Location header pointing at the job status. */
export class Accepted<T = any> extends Response<T> {
  protected _errorCode = HTTP_STATUS_CODE.ACCEPTED;
  protected _template = 'ok.pug';

  constructor(data: T, statusUrl: string, options?: IResponseOptions) {
    super(data, { ...options, Headers: [...(options?.Headers ?? []), { Name: 'Location', Value: statusUrl }] });
  }
}

@BasePath('exports')
export class ExportsController extends BaseController {
  @Post(':report')
  public start(@Param() report: string) {
    const jobId = `${report}-${Date.now()}`;
    return new Accepted({ jobId }, `/exports/jobs/${jobId}`);
  }

  @Post('jobs/:id')
  public status(@Param() id: string) {
    return new Ok({ id, state: 'running' });
  }
}
```

Override `execute()` when the body is not a model, for example a CSV export streamed by the response itself:

```ts sample
import { BaseController, BasePath, Get, Response } from '@spinajs/http';
import * as express from 'express';

export class CsvResponse extends Response<Array<Record<string, unknown>>> {
  constructor(rows: Array<Record<string, unknown>>, protected filename: string) {
    super(rows);
  }

  public async execute(_req: express.Request, res: express.Response): Promise<void> {
    const rows = (await this.prepareResponse()) as Array<Record<string, unknown>>;
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(this.filename)}`);
    res.send([columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n'));
  }
}

@BasePath('customers')
export class CustomersExportController extends BaseController {
  @Get('export.csv')
  public export() {
    return new CsvResponse([{ id: 1, name: 'ACME' }], 'customers.csv');
  }
}
```

## Important behaviour

- The status of a negotiated response is `options.StatusCode` when given, else the class's `_errorCode`.
- A JSON answer with status 400 or above always goes through the error transformer named by `x-error-transform`; an unknown name answers 400 `invalid data transformer`.
- `Xml` and the XML branch wrap arrays and scalars in `<response>`; an object becomes the document root, so give it a single root key for well-formed XML.
- `TemplateResponse` needs the `__fs_http_templates__` provider, which the package does not configure.
- `JsonFileResponse` needs a provider named `fs-temp`.
- An action must return a `Response`. A plain object fails with 500; `undefined` answers 404.
- Response data is serialized as is with `res.json()` (`JSON.stringify`); map domain objects to plain data before returning them.
- `FileResponse` with a remote provider downloads a temporary copy on every request. A range request transfers the whole object first, and the copy's `ETag` and `Last-Modified` change on every request, so 304 and `If-Range` never match. Serve ranges from a local provider; redirect to a presigned URL for a remote one.
- The `compression` middleware compresses a 200 or 206 of a compressible type (SVG, JSON, text) of 1 KiB or more, unless `Cache-Control` holds `no-transform`. A compressed 206 is a gzip of a part, which range clients cannot use. Put `no-transform` in `headers` for ranged files.
- The `ETag` of a file is weak and built from its size and modification time. Express' `etag` setting only turns it on or off.
- `ZipResponse` is always an attachment and takes neither `disposition` nor `headers`. It hands every failure of `send` to the error handler as it is, so a 412 or 416 of a zip answers 500.

## Best practices

- Throw a mapped exception (`ResourceNotFound`, `Forbidden`, `BadRequest`) from services, and return `Ok`/`Created` from actions; the error handler picks the status.
- Use `Json` for endpoints called by scripts that must never get HTML, such as webhooks.
- Restyle the HTML error pages by pointing `__fs_http_response_templates__` at a copy of `lib/views/responses`.

## Patterns and antipatterns

```ts
// Don't: write to res and return nothing; the response handler then raises 404 on a sent response.
@Get('ping')
public ping(@Res() res: express.Response) {
  res.json({ pong: true });
}

// Do
@Get('ping')
public ping() {
  return new Ok({ pong: true });
}
```

```ts
// Don't: IResponseOptions.Headers stay on every answer, so a missing file is a 404 cached for a year.
return new FileResponse({ provider: 'plan-tiles', path, disposition: 'inline' }, { Headers: [{ Name: 'Cache-Control', Value: 'public, max-age=31536000, immutable' }] });

// Do: headers of the file answer go in `headers`; an error answer never carries them.
return new FileResponse({ provider: 'plan-tiles', path, disposition: 'inline', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
```

## Examples

### Download an invoice PDF and delete the generated copy

```ts sample
import { BaseController, BasePath, FileResponse, Get, Param } from '@spinajs/http';

@BasePath('invoices')
export class InvoiceDownloadController extends BaseController {
  /** GET /invoices/2026-0042/pdf → attachment "invoice-2026-0042.pdf" */
  @Get(':number/pdf')
  public pdf(@Param() number: string) {
    return new FileResponse({
      provider: 'invoices',
      path: `generated/${number}.pdf`,
      filename: `invoice-${number}.pdf`,
      mimeType: 'application/pdf',
      deleteAfterDownload: true,
    });
  }
}
```

### Redirect after login with a signed cookie

```ts sample
import { BaseController, BasePath, HTTP_STATUS_CODE, Post, Redirect } from '@spinajs/http';

@BasePath('session')
export class SessionController extends BaseController {
  @Post('/')
  public login() {
    return new Redirect('/dashboard', HTTP_STATUS_CODE.SEE_OTHER, {
      Coockies: [{ Name: 'theme', Value: 'dark', Options: { signed: true, httpOnly: true, sameSite: 'lax' } }],
    });
  }
}
```

## Related

- [Error handling](11-error-handling.md): exceptions to responses.
- [Data transformers](12-data-transformers.md): `x-data-transform` and `x-error-transform`.
- [Cookies](20-cookies.md): `Coockies` in `IResponseOptions`.
- [`@spinajs/templates`](../templates/README.md), [`@spinajs/templates-pug`](../templates-pug/README.md): HTML rendering.
- [`@spinajs/fs`](../fs/README.md): providers used by file responses.
