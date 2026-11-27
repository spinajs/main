# Files per tenant

For the file providers listed in `tenancy.fs.prefixed`, a file written inside tenant `acme` is stored under `tenants/acme/` of that provider, and no path reaches above it. A tenant can have a provider of its own (its own bucket).

```ts
import '@spinajs/tenancy/fs';

// config
{ tenancy: { fs: { prefixed: ['uploads'], prefix: 'tenants/${tenant}/', dedicated: { uploads: { bigcorp: 'bigcorp-bucket' } } } } }

await runInTenant('acme', () => fs('uploads').write('logo.png', data));      // uploads: tenants/acme/logo.png
await runInTenant('bigcorp', () => fs('uploads').write('logo.png', data));   // bigcorp-bucket: logo.png
await fs('uploads').write('logo.png', data);                                 // TenantRequired
```

## How it works

1. Importing `@spinajs/tenancy/fs` registers `TenantFsLayer` (an `FsProviderLayer`, see [Provider layers](../fs/08-boot-service-and-provider-lookup.md#provider-layers)) and `TenantFsGuard` (an `FsMiddleware`, order -1000) in the root container. Without that import `tenancy.fs.prefixed` does nothing: the listed providers stay shared by all tenants and nothing reports it. A CLI process that does not import it writes the listed providers without a prefix.
2. A lookup by name of a listed provider (`getFs`, `provider()`, `@FileSystem()`) hands out a `TenantFs`, also outside a tenant scope: one per provider, with the provider's name and base path. Other providers are handed out as published. The published provider itself is never changed.
3. Every action of a `TenantFs` with no tenant scope, or across all tenants (`runAcrossTenants`), throws `TenantRequired`; `TenantFsGuard` refuses it before any other middleware, and the `TenantFs` refuses it again where it maps the path, so a guard that does not run lets nothing through. A job that visits every tenant uses `forEachTenant`.
4. Every other middleware sees the application's own path on the provider's own name. Then the `TenantFs` maps the path to `<prefix><path>` on the wrapped provider (or to the same path on the tenant's dedicated provider) and runs the wrapped provider's action inside the outer one, where no middleware runs again.
5. A path is normalised before it is mapped: a path that climbs above the root, holds a NUL byte or is a drive path outside the base is refused with `InvalidArgument`; an absolute path, also one inside the provider's base, is read from the root of the tenant's prefix, so it cannot reach another tenant. `resolvePath()` maps the same way. So a path the view returns (`resolvePath()`, `download()`, `unzip()`, `IZipResult.asFilePath()`) is an absolute path on the wrapped or dedicated provider; passed back to the same view in the same tenant it is read relative to the tenant's root, not prefixed again. An absolute path outside the tenant's own root is still read from the root of its prefix.
6. On a local provider (`fsNative`) a path that leads out of the tenant's files through a symbolic link or junction (one made outside the fs API) is refused with `InvalidArgument`. A link inside a directory that an action walks (zip, copy of a folder) is not checked, and a hard link is not detected. A tenant root or `tenants/` folder that is itself a link is refused, so move a provider to another disk with its `basePath`. The check runs when the action starts, so a link planted while the action runs is not seen.
7. Inside a tenant scope, an action that reaches a listed provider's shared files, or any dedicated provider by its own name (through `publishedFs()`, `getFs()`, `provider()` or `fs://` of that name, an instance kept from elsewhere, or as the destination of a copy, move, zip or unzip), is refused with `InvalidOperation`, the tenant's own dedicated provider included: a tenant reaches it through the listed provider's name. Outside a tenant scope every provider stays reachable for operator tasks. An `upload()` through the view whose local source lies in a listed or dedicated provider's directory outside the tenant's own files is refused with `InvalidArgument`; an `upload()` into a provider that is not listed does not check its source yet.
8. `unzip` into a tenant's whole root is refused for now. The extractor (`unzipper` 0.12) already skips an entry that climbs above the destination, so `../acme2/x` never lands in `tenants/acme2`; the refusal is defence in depth until `@spinajs/fs` checks entry names itself (it can be relaxed once `v4-sx-41-fs-unzip-entry-names` lands). Unzip into a directory below the root.
9. The tenant's prefix directory is created before each write, so a prefix an operator removed is made again.

## Refused configurations

`tenancy.fs` is read again on every lookup and every action. While one of these holds, every lookup of any provider by name, and every action of a provider already handed out, throws `InvalidOption`, which names the provider and the reason; a configuration refused when the application starts fails the start (`fsService` resolves the layers at the end of its boot):

| Configuration | Why |
| --- | --- |
| A listed provider with `authz.fs.<name>.mode` `audit` or `enforce` | the file ACL has no tenant; see below |
| A listed provider that `upload.fs.*` names | `@spinajs/upload` writes through `publishedFs()`, past the tenant view, also from its sweeper, which runs with no tenant |
| A listed provider that `email.templateFs` or a `logger.targets[].options.fs` / `archiveFs` names, a temporary file system (`service: 'fsTemp'`) or its backend, or a name that starts with `__fs_` | the framework reads and writes it outside any tenant scope (http response templates, swagger, logs, temporary files) |
| A dedicated provider that is listed itself, or dedicated to two tenants | one tenant would see another's files |
| An `FsProviderLayer` registered after `TenantFsLayer` | it could hand out a provider in place of the tenant's view; register it before importing `@spinajs/tenancy/fs` |
| No `TenantFsLayer` of this package registered (another class of the same name took its place in DI) | refused at every action on a listed provider |

Nothing refuses a listed provider that an `fs-path://` configuration value, a queue job without the tenancy queue hook, or other code running outside a tenant reads: its reads throw `TenantRequired`, so do not list one.

## Not together with file ACLs

In 4.0 one provider cannot both keep files per tenant and carry file ACLs of `@spinajs/authz-fs`. The file ACL is keyed by the provider name and the application's path, with no tenant: on a listed provider a grant on `reports/q1.pdf` in one tenant would open `reports/q1.pdf` of every tenant, the first uploader of `logo.png` anywhere would own `logo.png` everywhere, and removing a folder in one tenant would delete the ACL rows of all of them. So both packages refuse:

- `@spinajs/tenancy/fs` refuses a listed provider whose `authz.fs.<name>.mode` is `audit` or `enforce`, as in the table above. Because authz-fs looks up every provider it checks, every checked action on any provider throws `InvalidOption` too until the configuration is fixed.
- `@spinajs/authz-fs` refuses the file ACL of a listed provider in every mode, `off` included: `FsAcl.grant`, `revoke` and `list` and direct calls of `FileAclStore` throw `AuthzConfigError`, and a relation grant (`viewer`, `owner`) checked for a `fromFsPath` route or any other check of the provider's files is not held, so such a route answers 403 unless a grant without a relation allows it ([ACL store](../authz-fs/07-acl-store.md#important-behaviour)).

What to do instead:

- **Files that need ACLs go on a provider that is not listed**, with the tenant in the path the application stores. Each tenant's files then have their own ACL paths. Nothing checks that segment for you: a `fromFsPath` route takes the whole path from the request, so a user of `globex` who asks for `acme/reports/q1.pdf` is checked against acme's rows, and a row for every user of a type (`{ type: 'user', id: '*' }`) or on the provider's root answers in every tenant. Build the tenant segment in code (a resource extractor of your own that puts `requireTenant().id` in front of the parameter, and the same in every write), and grant to principals or sets of the tenant.
- **Files of a listed provider** are separated by the tenant scope alone: leave authz-fs off for that provider, use no `FsAcl` on it, and check access to them in the application.

```ts
// refused: one provider with both
{ tenancy: { fs: { prefixed: ['uploads'] } }, authz: { fs: { uploads: { mode: 'enforce' } } } }   // InvalidOption at the first lookup by name
await new FsAcl().grant('uploads', 'reports/q1.pdf', team, 'viewer');                              // AuthzConfigError, in mode 'off' too

// instead: tenant files on 'uploads', ACL-guarded files on 'documents' with the tenant in the path
{ tenancy: { fs: { prefixed: ['uploads'] } }, authz: { fs: { documents: { mode: 'enforce' } } } }
const path = `${requireTenant().id}/reports/q1.pdf`;
await getFs('documents').write(path, data);
await new FsAcl().grant('documents', path, team, 'viewer');
```

Per-tenant file ACLs (a tenant on each ACL row) are planned separately; they will lift both refusals.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tenancy.fs.prefixed` | string[] | `[]` | Providers whose files belong to one tenant each |
| `tenancy.fs.prefix` | string | `'tenants/${tenant}/'` | Where a tenant's files live in a listed provider; holds `${tenant}` once, relative, no `.` or `..` segment |
| `tenancy.fs.dedicated` | object | `{}` | `{ <provider>: { <tenant id>: <provider> } }`: the tenants of a listed provider that have a provider of their own |

## What it does not cover

- `publishedFs(name)` and a provider instance kept from before the lookup reach the raw provider outside a tenant scope. Use them for operator tasks over every tenant's files.
- Temporary paths (`tmppath`) are the wrapped provider's own; a write through the view to a `tmppath()` path lands under the tenant's prefix, not at that path.
- `zip()` on the view with no destination writes into the tenant's own root; an archive written to a provider that is not listed (the `zip()` helper defaults to `fs-temp`) is readable by every tenant that knows its name, so leave its name to `tmpname()`.
- A provider that is not listed but whose base path holds a listed provider's base path reaches every tenant's files.
- A provider taken off `tenancy.fs.dedicated` is an ordinary provider at once: every tenant reaches the files left on it. Move them before you change the entry.
- Files written before a provider was listed stay at their old paths. Move them under `tenants/<id>/` before listing the provider.
