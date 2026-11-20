---
"@spinajs/compiler": minor
---

`spinajs build` writes the manifest `tenancy` section and `ModelEntry.tenant`: tenant models (`@Tenant` and literal `registerTenantModel` of `@spinajs/tenancy-orm`, inherited through base classes, also from a dependency's fragment), the tenancy of every entry point (`@TenantRoute`, `@NoTenant`, `@AllTenants` of `@spinajs/tenancy-http` on a route or its controller, the `tenancy` option of `@Job` and `@Schedule`, and `none` when nothing is declared), every `.acrossTenants(reason)` and `runAcrossTenants(reason, fn)` call with its literal reason, and `// spinajs-tenancy-ignore TENxxx: <reason>` comments. A reason that is not a string literal is recorded as missing. A package that declares none of this gets no section, so its fragment is unchanged.

The three route decorators are in the middleware table: a route or controller that carries one records `{ type: 'TenantMiddleware', decoratorArgs }` in its `middlewares`, and an abstract controller that carries only one of them is kept as a base.
