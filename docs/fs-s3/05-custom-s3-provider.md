# Custom S3 provider

Subclass `fsS3` when one provider needs something the configuration cannot express: its own AWS credentials, extra headers on upload, another temp filesystem, or a hook around boot. `fsService` creates the subclass from config like the built-in provider.

## How it works

1. Decorate the subclass with `@Injectable('fs')` and `@PerInstanceCheck()`. The first puts it among the `fs` types `fsService` searches; the second gives one instance per provider `name`.
2. Set `service` in the provider entry to the subclass's class name. `fsService` matches `service` against `constructor.name`, so a minifier that renames classes breaks the match.
3. DI calls the constructor with the provider entry as its only argument, injects the inherited `@Config`, `@Logger`, `@Autoinject` and `@FileSystem` members, then awaits `resolve()`.
4. `fsS3.resolve()` builds the `S3Client` from `this.AwsConfig`, checks the bucket and resolves the signer. Call `super.resolve()` from an override.

Members a subclass can use or shadow:

| Member | Kind | Use |
| --- | --- | --- |
| `Options` | public, the provider entry | Read your own extra keys from it. |
| `AwsConfig` | protected, `@Config('fs.s3.config')` getter | Shadow per instance or redeclare with another `@Config` path for different credentials. |
| `S3` | protected `S3Client` | Send any `@aws-sdk/client-s3` command; set in `resolve()`. |
| `TempFs` | protected, `@FileSystem('fs-temp-s3')` getter | Redeclare with another `@FileSystem()` name. |
| `FileInfo` | protected `FileInfoService` | Used by `upload()`. |
| `Signer` | protected, optional | Set in `resolve()` from `Options.signer`. |
| `Logger` | protected, `@Logger('fs')` | Logs to the `fs` logger. |
| `resolve()`, `dispose()` | public lifecycle | Override and call `super`. |
| every `fs` method | public | Override to change one operation. |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `fs.providers[].service` | `string` | none | the subclass's class name | Selects your subclass. |
| `fs.providers[].<any>` | any | none | anything your subclass reads | The whole entry is the constructor argument, available as `this.Options`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `fsS3` | `'fs'` and the class itself; `PerInstanceCheck` per provider `name`; created by `fsService` at boot | `fsS3` | your subclasses | Subclass with `@Injectable('fs')` and `@PerInstanceCheck()`, import it before `fsService` resolves, set `service` to its name. Existing `service: 'fsS3'` entries are unaffected. |

### S3 provider: credentials per provider

`fs.s3.config` is shared by every `fsS3`. This subclass reads AWS settings from an `aws` key of its own provider entry, so each bucket can live in another account or region. `AwsConfig` is a getter on the `fsS3` prototype; an own property defined on the instance shadows it.

```ts sample
import { S3ClientConfig } from '@aws-sdk/client-s3';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsS3 } from '@spinajs/fs-s3';
import _ from 'lodash';

type S3ProviderOptions = ConstructorParameters<typeof fsS3>[0];

@Injectable('fs')
@PerInstanceCheck()
export class fsS3Account extends fsS3 {
  constructor(options: S3ProviderOptions & { aws: S3ClientConfig }) {
    super(options);
    Object.defineProperty(this, 'AwsConfig', { value: options.aws });
  }
}

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      fs: {
        providers: [
          {
            service: 'fsS3Account',
            name: 'partner-feed',
            bucket: 'partner-feed-eu',
            createBucketIfNotExists: false,
            aws: {
              region: 'eu-west-1',
              credentials: { accessKeyId: process.env.PARTNER_KEY_ID!, secretAccessKey: process.env.PARTNER_SECRET! },
            },
          },
        ],
      },
    });
  }
}
```

For one fixed second account, redeclare the property with another path instead: `@Config('fs.s3archive.config') protected AwsConfig: S3ClientConfig;`.

### S3 provider: set Content-Type on write

`write()` sets no `Content-Type`, so browsers download every signed file as binary. This override adds it from the extension and keeps the `hash` and `md5` metadata that `hash()` depends on.

```ts sample
import { Upload } from '@aws-sdk/lib-storage';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { fsS3 } from '@spinajs/fs-s3';
import crypto from 'crypto';
import { extname } from 'path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

@Injectable('fs')
@PerInstanceCheck()
export class fsS3Web extends fsS3 {
  public async write(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
    const digest = (algorithm: string) => {
      const h = crypto.createHash(algorithm);
      return (typeof data === 'string' ? h.update(data, encoding ?? 'utf8') : h.update(data)).digest('hex');
    };

    await new Upload({
      client: this.S3,
      params: {
        Bucket: this.Options.bucket,
        Key: path,
        Body: data,
        ContentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        Metadata: { hash: digest('sha256'), md5: digest('md5') },
      },
    }).done();
  }
}

// fs.providers: { service: 'fsS3Web', name: 'site', bucket: 'acme-static-site' }
```

### S3 provider: check bucket policy at boot

Override `resolve()` to add a boot check. Here the provider refuses to start when the bucket has no versioning, because the application relies on restoring overwritten reports.

```ts sample
import { GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { IOFail } from '@spinajs/exceptions';
import { fsS3 } from '@spinajs/fs-s3';

@Injectable('fs')
@PerInstanceCheck()
export class fsS3Versioned extends fsS3 {
  public async resolve(): Promise<void> {
    await super.resolve();

    const versioning = await this.S3.send(new GetBucketVersioningCommand({ Bucket: this.Options.bucket }));
    if (versioning.Status !== 'Enabled') {
      throw new IOFail(`Bucket ${this.Options.bucket} must have versioning enabled ( provider ${this.Name} )`);
    }
  }
}

// fs.providers: { service: 'fsS3Versioned', name: 'reports', bucket: 'acme-reports', createBucketIfNotExists: false }
```

## Important behaviour

- **Both decorators are required.** Without `@Injectable('fs')`, `fsService` throws `Type <service> not registered`. Without `@PerInstanceCheck()`, a subclass that declares its own `@Config` or `@Autoinject` member gets its own DI metadata with the default singleton lifetime, and every provider entry naming it receives the first entry's instance.
- **The subclass must be imported before `fsService` resolves.** Decorators register the class when its module loads.
- **`AwsConfig` is read once,** in `resolve()`, when the `S3Client` is created.
- **`fsService` sorts providers only by their `provider` key.** `fs-temp-s3` is read lazily, so its position in the list does not matter.
- **Overrides bypass base behaviour you do not repeat.** A `write()` override that omits the `hash` metadata makes `hash()` throw for those objects.

## Best practices

- Override one operation at a time and call `super` where the base behaviour still applies.
- Read custom settings from `this.Options` instead of new global config keys, so each provider entry stays self-contained.
- Keep class names stable and unminified: they are configuration values.

## Related

- [S3 file provider](01-s3-file-provider.md): what each base method does.
- [Temporary files](02-temporary-files.md): redeclaring `TempFs`.
- [Signed URLs](04-signed-urls.md): replacing the signer instead of the provider.
- [`@spinajs/fs`](../fs/README.md): `fsService`, `FsDecorator` for wrapping every provider without subclassing.
