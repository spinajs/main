# Documenting routes

Every route of every loaded controller becomes one OpenAPI operation. Decorators decide the path, the method and the parameters; JSDoc on the class and the method adds summaries, tags, responses, examples and security.

## How it works

1. `SwaggerDocCache.getCache()` asks `DefaultControllerCache` (`@spinajs/http`) for the controller's documentation. It parses the controller's `.d.ts` file, the compiled file name with `.js` replaced by `.d.ts`; see [Documentation cache](08-documentation-cache.md).
2. Per class, the JSDoc comment becomes the tag description, and `@tags` (or `@category`) becomes the tag name.
3. Per method, the first comment line becomes `summary`, the remaining lines become `description`, a return type annotation becomes the inferred response schema, and every known JSDoc tag fills one field.
4. `OpenApiBuilder.addController()` skips a controller without a runtime `Descriptor`. Otherwise it registers the controller tag and walks `Descriptor.Routes`.
5. Per route it builds the path, maps the route type to an HTTP method, and builds the operation: id, tags, summary, description, `deprecated`, `security`, parameters, request body, responses and examples.
6. Access and policy decorators add their extensions and description lines; see [Policies and access](05-policies-and-access.md).
7. The operation is stored under `paths[<path>][<method>]`. A second route with the same path and method overwrites the first.

A controller whose `file` is a placeholder such as `<dynamic>` (added with `Controllers.add()` with no source captured) is still documented from its decorators, with no JSDoc. Run from TypeScript sources (`ts-node`, tests), the `.ts` file itself is parsed.

## JSDoc tags

| Tag | Target | Format | Effect |
| --- | --- | --- | --- |
| comment text | class | free text | Description of the controller's tag |
| `@tags`, `@category` | class | `@tags Billing, Admin` | The **first** name is the tag of every route without its own `@tags`. Without it the tag is the class name minus `Controller` |
| first comment line | method | free text | `summary` |
| following comment lines | method | free text | `description` |
| `@summary` | method | `@summary Get one invoice` | Replaces the first-line summary |
| `@param` | method | `@param id Invoice number` or `@param {InvoiceDto} body Invoice to create` | Parameter or body description. A `{Type}` replaces the schema read from decorators |
| `@returns`, `@return` | method | `@returns {InvoiceDto} The invoice` | The `200` response, its description and its schema |
| `@response` | method | `@response 404 Invoice not found` or `@response 409 {ConflictDto} Already paid` | One more response per status code |
| `@body` | method | `@body {LoginBody} The credentials` | The JSON request body of a route that reads it without a body route argument (for example from `@Req()`): `requestBody` with the schema of the type, `required: true`. Ignored when the route has a body argument or the tag has no `{Type}` |
| `@example` | method | `@example <caption>Paid invoice</caption> {"id": 7}` | An example on the request body, or on the `200` response when there is no body |
| `@tags`, `@tag`, `@category` | method | `@tags Billing, Reports` | Replaces the controller tag for this operation |
| `@deprecated` | method | `@deprecated Use listV2` | `deprecated: true` |
| `@security` | method | `@security cookieAuth`, `@security cookieAuth, bearerAuth`, `@security []` | Operation-level security; see [Security](#security) |

## Paths and methods

| Route declaration | Documented path |
| --- | --- |
| `@BasePath('invoices')` + `@Get(':id')` | `/invoices/{id}` |
| `@BasePath('invoices')` + `@Get('/')` | `/invoices` (as the runtime mounts it) |
| `@BasePath('/')` + `@Get('health')` | `/health` |
| `@BasePath('invoices')` + `@Get()` on `archive()` | `/invoices/archive` (method name) |
| no `@BasePath` on `InvoicesController` | `/invoicescontroller/...` (lowercased class name, as the runtime mounts it) |
| `http.swagger.basePath: 'api'` | `/api` before every path |

Express parameters `:name` become `{name}`.

| Route type | OpenAPI method |
| --- | --- |
| `GET`, `FILE` | `get` |
| `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD` | the same, lowercase |
| anything else | the route is not documented |

`operationId` is `<ClassName>_<methodName>`, eg. `InvoiceController_getInvoice`.

## Responses

| Documentation | Result |
| --- | --- |
| `@returns {Type} text`, or a `@returns` with text only | `200` with `text` (default `Successful response`) and the schema of `Type`; without `Type`, the schema inferred from the return type annotation, else `{ type: 'object' }` |
| Return type annotation only, eg. `Promise<{ id: number }>` | `200` with the inferred schema. `@spinajs/http` unwraps `Promise`, `Ok`, `Json`, `Created` and the other response wrappers |
| Nothing | `200` with `Successful response` and no content |
| `@response 202 ...` and no explicit `@returns` | No `200` is added; the documented 2xx is the success response |
| `@response <code> text` for a standard code | `$ref: '#/components/responses/<Name>'`; the component's body is the shared `Error` schema |
| `@response <code> {Type} text` | Inline response with the schema of `Type` |
| `@response <code> text` for another code | Inline `{ description: text }` |

Standard codes and their components: `400` `BadRequest`, `401` `Unauthorized`, `403` `Forbidden`, `404` `NotFound`, `405` `MethodNotAllowed`, `406` `NotAcceptable`, `409` `Conflict`, `413` `PayloadTooLarge`, `422` `ValidationError`, `500` `ServerError`. A component is registered on first use; the first JSDoc text for a code becomes its description, else a built-in one.

`components.schemas.Error` matches the runtime error body: `message` (`string`, required), `code` (`integer`), `stack` (`object`, nullable, dev only).

### Type strings

| `{Type}` | Schema |
| --- | --- |
| `string` | `{ type: 'string' }` |
| `number` | `{ type: 'number' }` |
| `integer` | `{ type: 'integer' }` |
| `boolean` | `{ type: 'boolean' }` |
| `object` | `{ type: 'object' }` |
| `array` | array of strings |
| `X[]`, `Array<X>` | array of `X`, nested for `X[][]` |
| any other name | a named type, resolved to a component by the [schema providers](04-named-schemas-and-schema-providers.md) |

### File downloads

A route that returns a file is documented as a binary body, not as JSON. The class name comes from `@returns {Name}`, from `@response <code> {Name}`, or from the declared return type.

| Return class | Media type | Schema |
| --- | --- | --- |
| `FileResponse` | `application/octet-stream` | `{ type: 'string', format: 'binary' }` |
| `ZipResponse` | `application/zip` | same |
| `JsonFileResponse` | `application/json` | same |

## Examples

- Each `@example` becomes one entry in `examples`, keyed by its `<caption>` or `example_<n>`.
- The value is parsed as JSON; text that is not JSON stays a string.
- A route with a request body gets them on the body's media type (`application/json`, `application/xml` or `multipart/form-data`). A route without a body gets them on the `200` response.

## Security

| `@security` | Operation `security` | Meaning |
| --- | --- | --- |
| absent | unset | Inherits `http.swagger.security` |
| `@security []` | `[]` | Public, no authentication |
| `@security cookieAuth` | `[{ cookieAuth: [] }]` | Requires that scheme |
| `@security cookieAuth, bearerAuth` | `[{ cookieAuth: [] }, { bearerAuth: [] }]` | Either scheme (OpenAPI OR) |

Scopes cannot be written in the tag; every scheme gets an empty scope list.

## Important behaviour

- JSDoc is read from `.d.ts` files. Without them (`declaration: false`), hashing the missing file throws `IOFail` and the build fails. With `removeComments: true`, routes have no summaries, tags or responses.
- Only the first class tag names the controller's routes; `@tags A, B` on a class does not put the routes under `B`.
- Only the controller tags go into the top-level `tags` list. Tags named only on methods still work in Swagger UI, without a description.
- `@response <code> text` with a code outside the standard list gets no content schema.
- A named type inside `oneOf`, `anyOf` or `allOf` of a provider's schema becomes a `$ref` to its own component, as it does under `properties` and `items`.

## Best practices

- Write `@response` for every error the route throws on purpose; standard codes then share one component each.
- Use `@returns {Dto[]}` for lists. Without the brackets a client generator types the response as one object.
- Declare the return type as `Promise<FileResponse>` on download routes; the builder then documents a binary body without a JSDoc tag.

## Patterns and antipatterns

```ts
// Don't: a one-line comment with everything in it becomes a long summary
/** Lists invoices of the current month, paginated, newest first */

// Do: short first line for the summary, details below it
/**
 * List invoices
 * Invoices of the current month, paginated, newest first.
 */
```

## Examples

### Document an invoice controller

```ts sample
import { BaseController, BasePath, Body, FileResponse, Get, Ok, Param, Post } from '@spinajs/http';

interface IInvoice {
  id: number;
  total: number;
  paid: boolean;
}

/**
 * Invoices issued to customers.
 * @tags Billing
 */
@BasePath('invoices')
export class InvoiceController extends BaseController {
  /**
   * Get one invoice
   * Returns the invoice with its totals.
   * @param id Invoice number
   * @response 404 Invoice not found
   * @example
   * <caption>Paid invoice</caption>
   * {"id": 7, "total": 120.5, "paid": true}
   */
  @Get(':id')
  public async getInvoice(@Param() id: number): Promise<Ok<IInvoice>> {
    return new Ok({ id, total: 120.5, paid: true });
  }

  /**
   * Create an invoice
   * @param data Invoice lines and customer
   * @response 202 Accepted, the invoice is issued in the background
   * @response 422 Invalid invoice data
   * @security cookieAuth
   */
  @Post('/')
  public async create(@Body() data: object) {
    return new Ok({ queued: true, data });
  }

  /**
   * Download the invoice PDF
   * @response 404 Invoice not found
   * @security []
   */
  @Get(':id/pdf')
  public async pdf(@Param() id: number): Promise<FileResponse> {
    return new FileResponse({ path: `invoices/${id}.pdf`, filename: `invoice-${id}.pdf`, mimeType: 'application/pdf' });
  }

  /**
   * List invoices
   * @returns {IInvoice[]} Invoices of the current month
   * @deprecated Use the paginated report endpoint
   */
  @Get('/')
  public async list() {
    return new Ok([] as IInvoice[]);
  }
}
```

`create` gets `202`, `422` and no `200`. `pdf` is public and returns `application/octet-stream`. `list` returns an array of `IInvoice`, which needs a [schema provider](04-named-schemas-and-schema-providers.md) to become a component; without one the items stay `{ type: 'object', description: 'IInvoice' }`.

## Related

- [Parameters and request bodies](03-parameters-and-request-bodies.md): how arguments become parameters and bodies.
- [Named schemas and schema providers](04-named-schemas-and-schema-providers.md): how `{Type}` names become components.
- [Documentation cache](08-documentation-cache.md): where the JSDoc comes from and how to add tags.
