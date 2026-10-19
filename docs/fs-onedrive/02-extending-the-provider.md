# Extending the provider

`fsOneDrive` handles configuration, credentials and the Graph client; it implements no file operation. Subclass it to add the operations your app needs, or to point the client at another Graph cloud, and select the subclass with the `service` key of the provider entry.

Use this when you need OneDrive or SharePoint files today. Methods you do not override keep throwing `MethodNotImplemented`.

## How it works

1. You declare `class MyDrive extends fsOneDrive` and decorate it with `@Injectable('fs')` and `@PerInstanceCheck()`. `@Injectable('fs')` adds the class to the `fs` list when its module is imported; without it the subclass is not registered.
2. You set `service: 'MyDrive'` on the provider entry in `fs.providers`. `fsService` matches it against the class `name` of every type registered under `fs`.
3. `fsService` resolves `MyDrive` with the entry as constructor argument. The inherited constructor stores it in `Options`.
4. `MyDrive.resolve()` runs. When you do not override it, `fsOneDrive.resolve()` builds `OneDriveCredentials`, `Client` and `TempFs`. When you override it, call `super.resolve()` first.
5. Your overridden methods use `this.Client` (an authenticated Graph client) and `this.Options` (the entry, including your own keys).
6. `fsService` publishes the instance under `name` and applies the registered `FsDecorator`s. Callers reach it through `getFs()` or `@FileSystem()` without knowing the subclass.

`fsOneDrive` stays registered next to your subclass. Entries with `service: 'fsOneDrive'` keep getting the base class.

## Configuration

The subclass reads the same keys as `fsOneDrive` ([OneDrive provider: Configuration](01-onedrive-provider.md#configuration)). Only `service` changes.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers[].service` | `string` | none | class name of your subclass | Selects the subclass for this entry |
| `fs.providers[].drive` | `string` | none | Graph drive id | Not used by `fsOneDrive`; the subclass builds `/drives/{drive}/...` paths from it |
| `fs.providers[].<your key>` | any | none | any | Extra keys land in `Options`; extend `IOnedriveConfig` to type them |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsOneDrive` subclass | `fs` key, registered by `@Injectable('fs')` at import; `@PerInstanceCheck()` keyed on `name` | `fsOneDrive` | Any `fs` provider | Override the `fs` methods you need; select with `service: '<ClassName>'` |
| Graph connection in `resolve()` | Protected fields `Client`, `OneDriveCredentials`, `TempFs` | `ClientSecretCredential` + `Client.initWithMiddleware()` against `https://graph.microsoft.com/` | none shipped | Override `resolve()`, call `super.resolve()`, reassign `this.Client` |

What a subclass can override:

| Member | Override to |
| --- | --- |
| `read`, `readStream`, `write`, `writeStream`, `append` | Read and write file content through `/drives/{drive}/root:/{path}:/content` |
| `exists`, `dirExists`, `isDir`, `stat`, `list` | Query item metadata and folder children |
| `mkdir`, `rm`, `rename`, `copy`, `move` | Manage items |
| `download`, `upload` | Move files between the local disk and the drive; `TempFs` is the staging area for `download` |
| `resolvePath`, `tmppath`, `zip`, `unzip` | Required by `hash()`, `metadata()` and the zip helpers of `@spinajs/fs` |
| `signedUrl` | Optional on `fs`; return a sharing link |
| `resolve` | Change how the Graph client or credential is built |

### OneDrive provider: implement file operations

Override the operations you call. The class below implements reading, writing, listing, folder creation, deletion and download for one drive. Import its module before `fsService` resolves, so `@Injectable('fs')` has run.

```ts sample
import { basename, extname } from 'node:path';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsOneDrive } from '@spinajs/fs-onedrive';
import { GraphError, ResponseType } from '@microsoft/microsoft-graph-client';

@Injectable('fs')
@PerInstanceCheck()
export class fsOneDriveFiles extends fsOneDrive {
  protected item(path: string): string {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const root = `/drives/${this.Options.drive}/root`;
    return clean ? `${root}:/${encodeURI(clean)}:` : root;
  }

  public async read(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    const body: ArrayBuffer = await this.Client.api(`${this.item(path)}/content`).responseType(ResponseType.ARRAYBUFFER).get();
    const data = Buffer.from(body);
    return encoding ? data.toString(encoding) : data;
  }

  // Graph accepts a single PUT up to 4 MB; larger files need an upload session.
  public async write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    await this.Client.api(`${this.item(path)}/content`).put(body);
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await this.Client.api(this.item(path)).select('id').get();
      return true;
    } catch (err) {
      if (err instanceof GraphError && err.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  public async list(path: string): Promise<string[]> {
    const page: { value: { name: string }[] } = await this.Client.api(`${this.item(path)}/children`).select('name').get();
    return page.value.map((x) => x.name);
  }

  public async mkdir(path: string): Promise<void> {
    const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    await this.Client.api(`${this.item(parent)}/children`).post({
      name: basename(path),
      folder: {},
      '@microsoft.graph.conflictBehavior': 'replace',
    });
  }

  public async rm(path: string): Promise<void> {
    await this.Client.api(this.item(path)).delete();
  }

  public async download(path: string): Promise<string> {
    const local = this.tmpname(extname(path));
    await this.TempFs.write(local, (await this.read(path)) as Buffer);
    return this.TempFs.resolvePath(local);
  }
}
```

Select it in the provider entry:

```ts
{
  service: 'fsOneDriveFiles',
  name: 'sharepoint-documents',
  provider: 'fs-temp',
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  drive: process.env.SHAREPOINT_DRIVE_ID,
}
```

### Change the Graph cloud or token

`fsOneDrive.resolve()` always targets `https://graph.microsoft.com/` and the global Entra ID authority. The scope is read from `fsOneDrive.GRAPH_SCOPE` inside the auth provider, so redefining the static in a subclass has no effect. Override `resolve()` and replace `this.Client` instead.

`super.resolve()` still constructs a `ClientSecretCredential`, so `tenantId`, `clientId` and `clientSecret` must stay set. For a credential without a client secret (managed identity, certificate), extend `fs` from `@spinajs/fs` directly.

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsOneDrive, IOnedriveConfig } from '@spinajs/fs-onedrive';
import { AzureAuthorityHosts, ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';

export interface IGovOnedriveConfig extends IOnedriveConfig {
  graphUrl: string;
}

@Injectable('fs')
@PerInstanceCheck()
export class fsOneDriveGov extends fsOneDrive {
  constructor(public Options: IGovOnedriveConfig) {
    super(Options);
  }

  public async resolve() {
    await super.resolve();

    this.OneDriveCredentials = new ClientSecretCredential(this.Options.tenantId, this.Options.clientId, this.Options.clientSecret, {
      authorityHost: AzureAuthorityHosts.AzureGovernment,
    });

    const scope = `${this.Options.graphUrl}.default`;

    this.Client = Client.initWithMiddleware({
      baseUrl: this.Options.graphUrl,
      debugLogging: this.Options.debug,
      authProvider: {
        getAccessToken: async () => (await this.OneDriveCredentials.getToken(scope))?.token ?? '',
      },
    });

    this.Logger.info(`OneDrive provider ${this.Name} uses ${this.Options.graphUrl}`);
  }
}
```

The entry sets `service: 'fsOneDriveGov'` and `graphUrl: 'https://graph.microsoft.us/'`. Combine both techniques in one subclass to get a working provider in a national cloud.

## Important behaviour

- `fsService` matches `service` against `constructor.name`. A minifier that renames classes breaks the match; keep class names in production builds.
- Each subclass needs its own `@Injectable('fs')`: it registers the class when the decorator runs, and is not inherited. Without it boot fails with `ResolveException: Type <service> not registered`.
- Repeat `@PerInstanceCheck()` on the subclass. The container takes the lifetime from the nearest class with its own DI metadata, so a property decorator on the subclass (`@Logger()`, `@Autoinject()`, `@Config()`) resets it to singleton. Two entries with different `name`s then share one instance and one set of `Options`.
- The inherited `hash()` and `metadata()` call `resolvePath()` and expect a local path. A subclass that leaves `resolvePath()` unimplemented keeps them throwing `MethodNotImplemented`.
- `TempFs` is resolved inside `fsOneDrive.resolve()`. An override of `resolve()` that skips `super.resolve()` leaves `TempFs`, `Client` and `OneDriveCredentials` unset.
- `FsDecorator`s wrap the subclass instance like any provider, so access guards and logging decorators from `@spinajs/fs` apply unchanged.

## Best practices

- Implement the operations your callers use and leave the rest to the base class: a call to a missing method fails loudly with `MethodNotImplemented`.
- Build Graph paths from `Options.drive` (`/drives/{drive}/root:/{path}:`) so one class serves several drives, one provider entry per drive.
- Map Graph `404` (`GraphError.statusCode`) to `false` in `exists()`, `dirExists()` and `isDir()`, and rethrow every other error.
- Stage downloads in `TempFs`, so the temp cleanup strategy of `@spinajs/fs` removes them.

## Patterns and antipatterns

```ts
// Don't: the subclass is never registered, fsService cannot find 'fsOneDriveFiles'
export class fsOneDriveFiles extends fsOneDrive {
  public async read(path: string) { /* ... */ }
}

// Do: register the subclass under the fs key
@Injectable('fs')
@PerInstanceCheck()
export class fsOneDriveFiles extends fsOneDrive {
  public async read(path: string) { /* ... */ }
}
```

```ts
// Don't: Client and TempFs stay undefined
public async resolve() {
  this.Client = Client.initWithMiddleware({ authProvider });
}

// Do: let the base build its state first, then replace what you need
public async resolve() {
  await super.resolve();
  this.Client = Client.initWithMiddleware({ authProvider });
}
```

## Examples

### Archive monthly invoices to a SharePoint library

```ts sample
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fs, FileSystem } from '@spinajs/fs';
import { fsOneDrive } from '@spinajs/fs-onedrive';

@Injectable('fs')
@PerInstanceCheck()
export class fsOneDriveArchive extends fsOneDrive {
  protected item(path: string): string {
    return `/drives/${this.Options.drive}/root:/${encodeURI(path.replace(/^\/+/, ''))}:`;
  }

  public async write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    await this.Client.api(`${this.item(path)}/content`).put(body);
  }
}

// config: { service: 'fsOneDriveArchive', name: 'invoice-archive', provider: 'fs-temp', tenantId, clientId, clientSecret, drive }
export class InvoiceArchiver {
  @FileSystem('invoice-archive')
  protected Archive: fs;

  @FileSystem('fs-local')
  protected Local: fs;

  public async archive(month: string, invoiceFiles: string[]): Promise<void> {
    for (const file of invoiceFiles) {
      const pdf = await this.Local.read(`invoices/${month}/${file}`);
      await this.Archive.write(`Invoices/${month}/${file}`, pdf as Buffer);
    }
  }
}
```

## Related

- [OneDrive provider](01-onedrive-provider.md): configuration keys and the boot flow the subclass inherits.
- [`@spinajs/fs`](../fs/README.md): the full `fs` contract, `fsService`, `FsDecorator` and the temp provider.
- [`@spinajs/fs-s3`](../fs-s3/README.md): a complete remote provider to model the remaining operations on.
