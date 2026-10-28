---
"@spinajs/http": major
"@spinajs/http-swagger": major
---

Error bodies are now `application/problem+json` (RFC 9457) with an explicit field allowlist.

Before, the body was `{ ...err, message }` plus the stack outside production, so every own property of an exception reached the client. Now the body holds `type`, `title`, `status`, `detail` (the message), `instance`, and `code` or `errors` (Ajv errors of `ValidationFailed`) when present. Other exception properties are dropped unless listed in the new `http.errors.includeFields`; the stack is added only when `http.errors.includeStack` is true outside production (default false).

Migration: read `detail` instead of `message`, `errors` instead of `details`/`parameter`, and list any custom exception field the client needs in `http.errors.includeFields`. `CodedHttpException` answers the same document with `code` and `details`. `ProblemDetails`, `toProblem` and `PROBLEM_DETAILS_SCHEMA` are exported from `@spinajs/http`; the http-swagger error component is now `ProblemDetails`.

In production, an unmapped (generic 500) error answers `detail: "Internal server error"` without `code`; the message stays in the log. `code` is copied only from framework exceptions and from classes that list it in a static `problemFields`; prefer `problemFields` over the global `includeFields`. `instance` is the request path without the query.
