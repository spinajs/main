---
"@spinajs/authz": minor
"@spinajs/authz-http": minor
"@spinajs/http-socket": minor
---

`redact(value, fieldSet, schema?)` in `@spinajs/authz` is the one field filter for responses: each record keeps the fields its read set allows minus `fields.neverRead`, nested objects and arrays by dotted globs. A record can carry its own read set (`attachRowFields`, `rowFieldsOf`), which wins over the default one. With a schema, the nodes marked `x-spina-fields` are the records and the nodes above them an envelope; an envelope key the schema does not describe is filtered as a field of the envelope.

`@Access(…, { fields: 'filter-rows' })` and `@SocketAccess(…, { fields: 'filter-rows' })` are a 4.x opt-in: each row of a response keeps its own field set where one was computed, else the route decision's set as under `'filter'`. They set `AuthzRowFields` in the request storage for authz-orm; `runWithPrincipal` does not carry it over. `'filter'` behaves as before.
