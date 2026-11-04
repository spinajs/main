---
"@spinajs/http": minor
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

Pagination convention. `@spinajs/http` exports the type-only `Page<T>` (`{ items, total }`), `CursorPage<T>` (`{ items, next }`), `PageQuery` (`{ page?, pageSize? }`, `page` counting from 1) and `CursorQuery` (`{ cursor?, pageSize? }`). The compiler records an optional `RouteEntry.pagination` (`RoutePagination` in `@spinajs/manifest`) on a route whose reply is one of those two aliases, matched by their declaration in `@spinajs/http`, never by shape: its kind (`offset` or `cursor`), the item type, where the page parameter travels (`page`, or `cursor` and then `after`), where the page size travels (`pageSize`, `perPage` or `limit`) and, for `offset`, the first page from the parameter schema's `minimum` (0 or 1, default 1). An inherited route records the item type the subclass binds. `spinajs doctor` warns with `HTTP007` about a paginated route that has no page parameter. `manifest:diff` reports a route that loses its pagination, or changes its kind, as breaking; gaining it is not breaking on its own. The field is additive: `MANIFEST_VERSION` stays 2, and a manifest without paginated routes, its hash included, does not change. `orm-http` also exports a `Page` (the `{ limit, offset }` input): import one under another name where both are needed.
