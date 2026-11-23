---
"@spinajs/manifest": minor
---

The manifest has a `tenancy` section (`TenancySection`: tenant models, the tenancy of every entry point as `required`, `each`, `none` or `all`, every `acrossTenants` / `runAcrossTenants` escape with its reason, and `spinajs-tenancy-ignore` comments) and `ModelEntry.tenant` (`isolation`, `column`, `rls`). A fragment omits the section when the package declares none of it, so a manifest without tenancy is unchanged. An entry point that declares nothing is `none`. `mergeFragments` concatenates the sections and, once one package has one, lists the entry points of the others as well; when the build's `http.routes.middlewares` holds `TenantMiddleware`, every route that declares nothing and does not mount `TenantMiddleware` itself is `required`. A model another package registers is marked in the merged manifest.

`manifest:diff` has a `tenancy` section: a model becoming or ceasing to be a tenant model, a changed isolation, an entry point whose tenancy changed (breaking when a route now requires a tenant) and an escape added or removed, with its reason. A change that weakens isolation is listed and does not fail `--fail-on breaking`.
