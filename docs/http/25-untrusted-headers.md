# Untrusted request headers

Every request header comes from the client. This page lists each place in `packages/*/src` that reads one, what it does with the value, the risk, and why the code is safe or how it was fixed. Read a new header with [`strictHeader`](22-header-and-cookie-helpers.md#reading-an-untrusted-header) or a strict parse of its grammar.

## How it works

Node's HTTP parser (llhttp, with `insecureHTTPParser` off, the default) runs before any framework code. On Node 24 it:

1. Answers 400 and closes the connection for a control character in a value (CR, LF, NUL, ESC, DEL; a tab is allowed), a space before the colon, a folded line, a repeated or non-numeric `Content-Length`, `Content-Length` with `Transfer-Encoding`, and an HTTP/1.1 request without `Host`.
2. Answers 431 when all headers pass `maxHeaderSize` (16 KiB by default).
3. Drops the spaces and tabs around a value, and decodes its bytes as latin1.
4. Folds a repeated header into `req.headers`: `Cookie` is joined with `; `, `Set-Cookie` becomes an array, `Authorization`, `Host`, `Content-Type`, `User-Agent`, `Referer` and a few others keep the first copy only, and every other header is joined with `, `. `req.rawHeaders` keeps each copy.

So no CR/LF reaches a log or a response (NEL, U+0085, and tab pass the parser), and it is never longer than 16 KiB. What the framework must still check: the grammar of the value, a bound below 16 KiB where the value is stored or parsed, and a repeat that Node folded.

## Audit

Status: **Fixed** names the change; **Safe** cites the code that makes it so; **Kept** points to a [decision](#decisions) to leave the behavior as it is. Lines are as of this page.

### `@spinajs/http`

| Package | File:line | Header | Use | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| http | `src/response-methods/file.ts:171` | `Range` | Rewrites a suffix `bytes=-N` with `N` at least the file size to `bytes=0-`, and drops `bytes=-`. | A second grammar beside range-parser: spaces, tabs and Unicode spaces anywhere, unbounded digits. | **Fixed**: read with `strictHeader` (sent once, at most 64 characters), then only exactly `bytes=-` or `^bytes=-(\d{1,15})$` is rewritten. Everything else reaches range-parser as sent. |
| http | `src/response-methods/file.ts:112` | `Range` | Kept, and put back after `send`. | None: copied back as is. | Safe. |
| http | `src/response-methods/send-file.ts:16`, `src/server.ts:228` | `Range`, `If-Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`, `Cache-Control` | `send` answers 206, 304, 412 and 416 for `FileResponse` and static files. | Parser disagreement. | Safe: `send`, range-parser and fresh are the only parsers; the rewrite above changes only its exact forms. |
| http | `src/responses.ts:225`, `src/responses.ts:228` | `x-error-transform` | Picks the `DataTransformer` whose `Type` equals it. | Echoed in the 400 body; a repeat joined; up to 16 KiB. | **Fixed**: sent once and at most 256 characters, else no transformer; repeated in the message only when it is an RFC 9110 token (`src/responses.ts:244`). |
| http | `src/responses.ts:288` | `x-data-transform` | As above, for answers below 400. | As above. | **Fixed**: as above. |
| http | `src/responses.ts:146`, `src/responses.ts:304`, `src/responses.ts:312`, `src/error.ts:155`, `src/route-args/RequestFields.ts:45` | `Accept` | Content negotiation with `req.accepts`. | ReDoS in the negotiation parser. | Safe: accepts 2 and negotiator 1 split the list linearly, and the media-type pattern has no overlapping quantifiers. The result only picks a branch. |
| http | `src/middlewares/Cors.ts:105` | `Origin` | Echoed in `Access-Control-Allow-Origin`. | Origin reflection. | Safe: echoed only when the exact value is in the set of normalized `http.cors.origins`; a repeated `Origin` (`a, b`) matches nothing. |
| http | `src/middlewares/Cors.ts:113` | `Access-Control-Request-Method` | Marks a preflight. | None: presence only. | Safe. |
| http | `src/middlewares/Cors.ts:115`, `src/middlewares/Cors.ts:120` | `Access-Control-Request-Headers` | Echoed in `Access-Control-Allow-Headers` without `allowedHeaders`. | Arbitrary text reflected into a response header. | **Fixed**: only entries that are RFC 9110 field names are echoed; `Forwarded` and `X-Forwarded-*` stay out. Node's parser and `setHeader` already refuse CR and LF, so no header could be injected. |
| http | `src/middlewares/Csrf.ts:185`, `src/middlewares/Csrf.ts:186`, `src/middlewares/Csrf.ts:189` | `Origin`, `Sec-Fetch-Site`, `Cookie` | The CSRF decision. | A forged or repeated value. | Safe: `Origin` must equal its own `parseOrigin()` serialization, so a repeated one is malformed and refused; `Sec-Fetch-Site` is compared exactly; cookie names come from the configuration. |
| http | `src/middlewares/SameOrigin.ts:102`, `src/middlewares/SameOrigin.ts:103` | `Origin`, `Sec-Fetch-Site` | The same-origin decision. | As above. | Safe: `parseOrigin()` is an anchored pattern followed by `new URL`; the rest are exact compares. |
| http | `src/middlewares/RealIp.ts:145`, `src/middlewares/RealIp.ts:30` | `X-Forwarded-For` | `req.storage.realIp` through the trusted hops. | A spoofed address; a long list; an IPv6 zone id (`fe80::1%eth0`), which `isIP` accepts. | **Fixed** (zone id): entries are read right to left only while the peer is trusted, and each must pass `isIP` and hold no `%`; an entry that fails stops the walk. The split is linear. Node joins a repeat with `, `, the same list. |
| http | `src/middlewares/RealIp.ts:113`, `src/middlewares/RealIp.ts:114` | `X-Forwarded-Proto`, `X-Forwarded-Host`, `Host` | The app's own origin for the CSRF and same-origin guards. | Host header injection; a client-set first entry behind an appending proxy. | Safe for this use: callers pass the result through `parseOrigin()`, so a `Host` with a path or junk gives no origin and the request is refused. **Kept**: the first value from a trusted peer, see [decision 2](#decisions). |
| http | `src/middlewares/Throttle.ts:166` | `X-Forwarded-For`, through `realIp` | The throttle key. | A key the client chooses. | Safe: never `req.ip`; `realIp` passed `isIP` and holds no zone id. |
| http | `src/middlewares/RequestId.ts:35` | `traceparent` | Continues a W3C trace. | Log injection; the value echoed. | Safe: `parseTraceparent()` in `@spinajs/log` is an anchored, fixed-length hex pattern; only the parsed ids are logged and sent back. A repeat (`a, b`) starts a new trace. |
| http | `src/middlewares/AccessLog.ts:51` | `User-Agent` | Logged as a field of the access line. | Log injection; size. | Safe: Node refuses control characters with 400 and bounds the value; it is a field, not part of the message template. |
| http | `src/body-limits.ts:92` | `Content-Length` | An early 413 for a path's body limit. | Request smuggling; a value that is not a number. | Safe: llhttp refuses a non-digit or repeated `Content-Length` and one with `Transfer-Encoding`; the body parser still counts the bytes. |
| http | `src/config/http.ts:106`, `src/config/http.ts:114`, `src/config/http.ts:119` | `Content-Type`, `Content-Encoding`, `Content-Length` | `express.json`, `express.urlencoded`, `express.text`. | Parser disagreement. | Safe: delegated to body-parser (content-type, type-is, raw-body); limits count the decoded bytes. |
| http | `src/config/http.ts:123` | `Cookie` | `req.cookies` and `req.signedCookies` (cookie-parser). | A repeated name; forged signatures. | Safe: cookie 0.7 parses linearly and keeps the first of a repeated name; signatures are checked by cookie-signature in constant time. |
| http | `src/config/http.ts:124` | `Accept-Encoding` | `compression` negotiation. | ReDoS. | Safe: negotiator, as for `Accept`. |
| http | `src/route-args/FromForm.ts:46` | `Content-Type` (boundary), part headers | Multipart parsing by formidable 3.5. | Parser bugs. | Safe: delegated; size and count limits come from the upload options. |
| http | `src/route-args/ContentDigestArg.ts:27` | `Content-Digest` | `@ContentDigest()`. | ReDoS; a repeat. | Safe: a sticky structured-field tokenizer with single quantifiers; a repeat is the joined dictionary RFC 8941 defines. |
| http | `src/route-args/FromCookie.ts:28`, `src/route-args/FromCookie.ts:30` | `Cookie` | `@Cookie()`. | A forged signed value. | Safe: a `secure` cookie is verified; the name comes from code. |
| http | `src/route-args/FromHeaderArg.ts:38`, `src/route-args/FromHeaderArg.ts:42` | any, by `@Header()` | The argument, converted and validated. | Case of the key; a folded repeat; size. | **Fixed**: the key is looked up in lower case, so `@Header('X-Signature')` reads `x-signature`. The opt-in options `once`, `maxLength` and `pattern` read it with `strictHeaderReader` and answer 400 for a repeat, a longer value or a mismatch ([decision 3](#decisions)). Without them, repeats and size are left to the route's schema. |
| http | `src/route-args/RequestContext.ts:45` | `User-Agent`, by `@UserAgent()` | Passed to the action. | The app's use. | Safe: passed as is; bounded and control-character free by Node. |
| http | `src/route-args/RequestContext.ts:59` | `Referer` or `Referrer`, by `@Referer()` | Passed to the action. | The app's use. | Safe: as above. |
| http | `src/route-args/RequestFields.ts:80` | all, by `@HeadersField()` | `req.headers` passed to the action. | The app's use. | Safe: as above. |
| http | `src/bot/service.ts:90` | `x-bot-token` (`http.bot.header`) | The token sent to the verifier. | Size; a repeat. | Safe: a string of 1 to 2048 characters (`BOT_TOKEN_MAX_LENGTH`), else `missing`. **Kept**: a repeat is one joined token the provider refuses ([decision 5](#decisions)). |
| http | `src/bot/service.ts:99` | `x-bot-verifier` (`http.bot.verifierHeader`) | Picks the fallback verifier. | The client choosing a verifier. | Safe: compared exactly with the configured verifier and fallback; any other value fails the check. |
| http | `src/bot/service.ts:69`, `src/bot/service.ts:70` | `Host`, by `req.hostname` | Verifier input. | A spoofed `Host`. | Safe: the framework never sets express's `trust proxy`, so `req.hostname` is `Host` and `req.ip` the socket address; the shipped verifiers check the hostname the provider answers. |

### Authentication and authorization

| Package | File:line | Header | Use | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| authn-http | `src/middleware/authn.ts:206`, `src/middleware/authn.ts:30` | `Authorization`, `Proxy-Authorization`, `authn.token.headerName`; all, from `rawHeaders` | The `SignedRequest` the credential extractors read. | A repeat hidden by Node: which copy is the credential, and a refused `Authorization` falling through to `x-api-key`. | **Fixed**: a singleton credential header sent more than once answers 400 before any extractor runs ([decision 6](#decisions)). Every other header is built from `rawHeaders`, a repeat joined with `, `, so `Signature` and the fields it covers keep the value RFC 9421 §2.1 signs. |
| authn-http | `src/extractors/bearer.ts:39` | `Authorization` | Bearer token or JWS assertion. | ReDoS; a repeat. | Safe: an anchored `b64token` pattern; `MALFORMED_BEARER` (`^Bearer +(.+)$`) is linear; a repeat never reaches it (row above). |
| authn-http | `src/extractors/bearer.ts:72` | `x-api-key` (`authn.token.headerName`) | A prefixed API token. | As above. | Safe: the anchored `TOKEN` pattern and the prefix check. |
| authn-http | `src/extractors/signature.ts:42`, `src/extractors/signature.ts:45` | `Signature`, `Signature-Input`, covered headers | Hands the request to authn-keys. | See authn-keys. | Safe: see the authn-keys rows. |
| authn-http | `src/middleware/authn.ts:43`, `src/middleware/authn.ts:44` | `Content-Length`, `Transfer-Encoding` | Whether a body exists for the signature digest. | A body that verifies as empty. | Safe: presence only; a body no parser kept is replaced by random bytes, so it never verifies. |
| authn-http | `src/middleware/authn.ts:179`, `src/middleware/authn.ts:180` | `Cookie` (session) | Restores the session. | A forged id. | Safe: the signature is verified; a bad one is logged as a hash only. |
| authn-http | `src/middleware/client-ip.ts:36` | `X-Forwarded-For` | `req.storage.ClientIp`. | A spoofed address. | Safe: `trustedClientAddress()`, as `RealIp`. |
| authn-http | `src/middleware/csrf.ts:125` | `Origin`, `Sec-Fetch-Site` | The refusal log line. | Log injection. | Safe: logs `parseOrigin(origin)` or `malformed`, `Sec-Fetch-Site` only when it matches `^[a-z-]{1,16}$`, clipped to 120 characters and rate-limited. |
| authn-http | `src/v3/client.ts:18` | `User-Agent` | Session list and audit events. | Size in storage. | Safe: cut to 512 characters on the session (`src/v3/routes.ts:35`) and 255 in the ORM audit sink; the log audit sink never writes it. |
| authn-http | `src/v3/controllers/AuthnLoginController.ts:89`, `src/v3/controllers/AuthnLoginController.ts:90` | `Sec-Fetch-Mode`, `Accept` | Redirect or JSON answer. | Size. | Safe: schemas with `maxLength` 64 and 16384; compared exactly or with `/\btext\/html\b/i`. |
| authn-http | `src/socket/session-source.ts:100`, `src/socket/session-source.ts:116` | `Cookie`, `User-Agent` (socket handshake) | The socket's session principal. | A forged id. | Safe: the cookie comes from `parseCookies()` (first wins, no prototype) and its signature is verified. |
| authn-keys | `src/strategies/httpsig.ts:68`, `src/strategies/httpsig.ts:72` | `Signature`, `Signature-Input` | RFC 9421 verification. | ReDoS; size. | Safe: each value is at most 8192 characters (`MAX_CREDENTIAL_LENGTH`) before parsing; the field parsers use anchored patterns with single quantifiers. |
| authn-keys | `src/strategies/httpsig.ts:62` | `Signature-Input` (`keyid`) | Throttle key. | Size. | Safe: parsed only up to 8192 characters. |
| authn-keys | `src/httpsig/base.ts:42` | covered headers | The signature base. | A line injected into the base; prototype names. | Safe: names must match `HEADER_NAME`, a value with CR or LF is refused, and a non-string (an `Object.prototype` member) is no value. A repeat is the joined value RFC 9421 §2.1 signs. |
| authn-oidc | `src/controllers/OidcController.ts:157` to `:163`, and the same arguments on the other routes | `User-Agent`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Accept`, `Cookie` | Login context, navigation, the flow cookie. | Size. | Safe: `@Header` schemas with `maxLength` 16384 (`OIDC_HEADER_MAX`); the flow cookie is found by its exact name. |
| authn-oidc | `src/controllers/OidcController.ts:158` to `:160`, `src/controllers/OidcController.ts:296` | `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host` | The origin of the default `redirect_uri`. | Host header injection. | **Fixed** ([decision 1](#decisions)): `authn.http.publicOrigin` when set; else each value at most 2048 characters and the origin through `parseOrigin()`, or the flow answers 400 `E_OIDC_ORIGIN`. A well-formed forged `Host` still passes: the provider's exact match of the registered redirect URI guards it, and production boot warns. |
| authn-oidc | `src/controllers/OidcController.ts:229`, `src/controllers/OidcController.ts:242` | `Content-Type` | Back-channel logout form. | Size. | Safe: at most 256 characters; the media type is compared exactly. |
| authn-oidc | `src/logout-extension.ts:99` | `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host` | The origin of the post-logout redirect. | Host header injection. | **Fixed** ([decision 1](#decisions)): as the row above; without a valid origin the provider's logout URL has no `post_logout_redirect_uri`, so the provider ends its session and shows its own page. |
| authz-http | `src/principals/service-source.ts:38` | the configured service header | A service token. | Timing; size. | Safe: 1 to 1024 characters by schema, compared as digests with `timingSafeEqual`; a repeat is a joined wrong token. |
| authz-http | `src/principals/link-source.ts:76`, `src/principals/link-source.ts:77` | the configured link header or cookie | A share-link token. | Size. | Safe: a string validated to at most 512 characters before the resolver sees it. |
| telemetry | `src/policies/TelemetryTokenPolicy.ts:51`, `src/policies/TelemetryTokenPolicy.ts:78` | `x-metrics-token`, `Authorization` | The metrics token. | Timing. | Safe: compared as SHA-256 digests with `timingSafeEqual` and never logged. `Bearer ` is matched case-sensitively, so a lower-case scheme is refused. |
| users-http | `src/admin/controllers/Users/Security.ts:252` | `User-Agent` | An audit event. | Size in storage. | Safe: as the authn-http `User-Agent` row. |

### Other packages

| Package | File:line | Header | Use | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| http-socket | `src/authn-source.ts:41`, `src/authn-source.ts:19`, `src/connection.ts:49` | all handshake headers | The `SignedRequest` for authn. | socket.io's `handshake.headers` keeps only the first `Authorization`, which hides a second credential. | **Fixed**: `Authorization`, `Proxy-Authorization` or `authn.token.headerName` sent more than once refuses the handshake with `invalid_argument`, as authn-http answers 400 ([decision 6](#decisions)). Any other repeated header is joined from `rawHeaders`; a value a subclass put in `headers` is kept. |
| http-socket | `src/authn-source.ts:49` | `auth.token` (payload) | Becomes `Authorization: Bearer`. | Size. | Safe: a string, bounded by `maxHttpBufferSize`, parsed by the same extractors. |
| http-socket | `src/server.ts:299`, `src/origin.ts:61`, `src/origin.ts:62` | `Sec-Fetch-Site`, `Origin` | JSONP and cross-site refusal. | A forged value. | Safe: exact compares. |
| http-socket | `src/server.ts:365`, `src/server.ts:448`, `src/origin.ts:32`, `src/origin.ts:43` | `Origin`, `Host` | The handshake origin check. | Origin reflection; Host injection. | Safe: an exact list match, or same origin through `BARE_HOST` and `new URL`; `null` and `*` are refused; a repeated `Origin` is no URL. |
| http-socket | `src/connection.ts:50` | `Cookie` | `handshake.cookies`. | A repeated name. | Safe: `parseCookies()` has no prototype and keeps the first; `AuthnCredentialSource` never reads cookies. |
| http-socket | `src/connection.ts:51`, `src/client-address.ts:16` | `X-Forwarded-For` | The client address. | A spoofed address. | Safe: `trustedClientAddress()`, as `RealIp`. |
| http-socket | `src/authn-source.ts:123` | `User-Agent` | The authn context. | Size in storage. | Safe: as the authn-http `User-Agent` row. |
| http-socket | `src/policies.ts:41` | all | Passed to socket policies. | The app's use. | Safe: the app's own code reads them. |
| intl-http | `src/index.ts:17` to `:23` | `x-<intl.queryParameter>`, a cookie | The request language. | Prototype keys; SQL. | Safe: `_validate()` (`src/index.ts:33`) accepts only a string of 2 to 5 characters; it is a bound value in intl-orm's `where('Lang', …)` and a locale table key, and no `Object.prototype` member is 2 to 5 characters long. |
| orm-http | `src/index.ts:56` | `@AsModel` with `type: FromHeader` | JSON hydrated into a model. | Parsing; prototype keys. | Safe: `JSON.parse`, then the model's schema validation, as for a body. |
| orm-http | `src/index.ts:123` | `@FromModel` with `paramType: FromHeader` | Primary-key lookup. | SQL. | Safe: a bound query parameter. |
| scheduler-http | `src/controllers/RunsController.ts:130`, `src/controllers/SchedulesController.ts:143` | `Last-Event-ID` | The SSE resume position. | Unbounded digits: `Number()` rounds past 2^53 and gives `Infinity` past 308 digits, so the stream resumes at a wrong position or from the start. | **Fixed**: the schema is `^\d{1,15}$`; a longer id answers 400. |
| upload | `src/http/request-body.ts:8` | `Content-Length` | Reads off a small refused body. | A value that is not a number. | Safe: `^\d+$` and a safe integer. |

Outgoing requests (`authn-oidc/src/http/client.ts`, webhook sinks, `http-bot/src/fetch.ts`, `email-verification`, log shippers) and `http-socket-client` read no request headers, so they are out of scope.

## Decisions

The first audit left five questions that needed a decision beyond a strict parse; the sixth came with the answers.

1. **Host in OIDC redirect URIs: fixed.** `authn-oidc` takes the default `redirect_uri` and post-logout origin from `authn.http.publicOrigin` when it is set. Otherwise it builds the origin from `Host`, or `X-Forwarded-Host` from a trusted peer, and runs it through `parseOrigin()`. A value longer than 2048 characters, or an origin `parseOrigin()` refuses, answers **400** `{ error: { code: 'E_OIDC_ORIGIN' } }` on the routes that start a flow, and no flow starts. 400, not 5xx: the client or its proxy sent the malformed header, and a retry cannot succeed. The RP-initiated logout leaves out `post_logout_redirect_uri` instead, because the session is already revoked. Outside development and test, `OidcProviders` warns at boot for each provider without `redirectUri` when `authn.http.publicOrigin` is unset.
2. **First X-Forwarded-Proto and -Host value: kept.** `requestOrigin()` takes the first value from a trusted peer, as express does. Behind several hops, the first entry can come from the client when the outer proxy appends instead of overwriting. Configure the outer proxy to overwrite both headers, or set `authn.http.publicOrigin` for OIDC. Reading the hop-aligned entry, as `X-Forwarded-For` does, would change the `http.trustProxy` semantics.
3. **Repeats in `@Header()`: opt-in options.** `once`, `maxLength` and `pattern` read the header with `strictHeaderReader` and answer 400 for a repeat, a longer value or a mismatch; the decorator checks the options when it runs. Without them the argument gets Node's folded value, as before. The next major makes `once` the default.
4. **IPv6 zone ids: fixed.** An address with `%` is no address: it stops the `X-Forwarded-For` walk and is no trusted peer, and an `http.trustProxy` entry with one fails the boot. A zone id never reaches `realIp`, `ClientIp` or a throttle key.
5. **A repeated bot token: kept.** It reaches the provider as one joined token and fails as `failed`, at the cost of a provider call. `strictHeader` would answer `missing` without the call, but change the reason clients see.
6. **Repeated credential headers: refused.** `Authorization` and `Proxy-Authorization` are singleton fields (RFC 9110 §5.3, §11.6.2, §11.7.2), and so is the `authn.token.headerName` header. Sent more than once, authn-http answers **400** `{ code: 'E_REPEATED_CREDENTIAL_HEADER' }` and http-socket refuses the handshake with `invalid_argument`, before any extractor or strategy runs. Both say the request is malformed, which a retry cannot fix, and neither says anything about the credential. A request with an active session reads no credential header, so it is not refused. Other headers still arrive joined: `Signature`, `Signature-Input` and the fields a signature covers may span lines, and RFC 9421 §2.1 signs the joined value.

## Best practices

- Read a header you add with `strictHeader(req, name, { maxLength, pattern })`, and give a `@Header()` argument `{ maxLength, pattern }`, or `{ once: true }`.
- Treat `undefined` from `strictHeader` like a malformed value of your grammar, not like an absent header, when absence has a meaning of its own.
- Never repeat a header value back unless it matched a strict grammar; prefer a fixed message.
- Compare tokens as digests with `timingSafeEqual`, as `ServicePrincipalSource` and `TelemetryTokenPolicy` do.

## Related

- [Header and cookie helpers](22-header-and-cookie-helpers.md): `strictHeader`, `repeatedHeader`, `normalizeHeaders`, `parseBearer`, `parseCookieHeader`.
- [Route arguments](04-route-arguments.md): `@Header()` and its options.
- [Responses](10-responses.md#file-responses): the `Range` rules of `FileResponse`.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): `http.trustProxy` and `requestOrigin`.
- [CORS](16-cors.md): the preflight echo.
