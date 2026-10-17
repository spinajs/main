# Responses

An action returns a `Response` object; the framework turns it into the HTTP answer. Most response classes pick the format from the request's `Accept` header (JSON, HTML from a pug template, XML or text) and set their own status code. `Json` and `Xml` always answer in one format; `FileResponse`, `ZipResponse`, `JsonFileResponse` send a download; `TemplateResponse` renders a page; `Redirect` redirects.

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
| `EntityTooLarge` | 413 | `entityTooLarge.pug` | `EntityTooLargeException` | |
| `ServerError` | 500 | `serverError.pug` | `MethodNotImplemented`, `IOFail`, `UnexpectedServerError`, and every unmapped error | |
| `Json` | 200 or `options.StatusCode` | none | | Always JSON. |
| `Xml` | 200 or `options.StatusCode` | none | | Always XML. Third argument: `XMLBuilder` options. |
| `TemplateResponse` | 200 or `options.StatusCode` | the given file | | Renders `file` from the `__fs_http_templates__` provider, or `{ template, provider }` from another provider. Throws `IOFail` when the provider is missing. |
| `FileResponse` | 200 | none | | Sends a file from a provider (default `local`) as an attachment. See below. |
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
| `filename` | `string` | | Download name, sent as `Content-Disposition: attachment; filename*=UTF-8''...`. |
| `provider` | `string` | `'local'` | File provider name. |
| `mimeType` | `string` | from the file (`FileResponse`), `application/zip` (`ZipResponse`) | `Content-Type`. |
| `deleteAfterDownload` | `boolean` | `false` | `FileResponse` removes the source file after sending. |

`FileResponse` throws `ResourceNotFound` (404) when the file does not exist and `IOFail` when the provider is not registered. For a remote provider it downloads a temporary copy and deletes it after sending; a local file is sent in place.

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
