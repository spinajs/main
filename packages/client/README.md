# @spinajs/client

Typed HTTP client for SpinaJS applications. The runtime (`@spinajs/client/runtime`) is browser-safe: `createClient(definition, options)` turns a route table into typed fetch calls, throws `ProblemError` on `application/problem+json` replies and serialises query strings in `qs` bracket notation.
