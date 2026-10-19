# `@spinajs/fs-onedrive`

A Microsoft OneDrive / SharePoint file provider for `@spinajs/fs`. `fsOneDrive` authenticates against Microsoft Entra ID with a client secret and builds a Microsoft Graph client at boot.

It does **not** perform file operations yet. Every `fs` method (`read`, `write`, `list`, `exists`, `download`, ...) throws `MethodNotImplemented`. Use it as a configured, authenticated base class and implement the operations you need in a subclass (see [Extending the provider](02-extending-the-provider.md)).

## Install

```sh
npm install @spinajs/fs-onedrive
```

## Features

| Feature | What it does |
| --- | --- |
| [OneDrive provider](01-onedrive-provider.md) | `fsOneDrive`: provider configuration, the boot flow that creates the Graph client, and the current not-implemented surface |
| [Extending the provider](02-extending-the-provider.md) | Subclass `fsOneDrive` to implement file operations through Graph, change the Graph endpoint or token, and select the subclass from config |

## Quick start

Configure a OneDrive provider next to the temp provider it needs, then resolve it by name.

```ts sample
import '@spinajs/fs-onedrive';
import { DI } from '@spinajs/di';
import { fsService, getFs } from '@spinajs/fs';
import { MethodNotImplemented } from '@spinajs/exceptions';

// config/fs.ts
export const config = {
  fs: {
    defaultProvider: 'fs-local',
    providers: [
      { service: 'fsNative', name: 'fs-local', basePath: '/var/app/data' },
      { service: 'fsTemp', name: 'fs-temp', provider: 'fs-local' },
      {
        service: 'fsOneDrive',
        name: 'onedrive',
        provider: 'fs-temp',
        tenantId: process.env.AZURE_TENANT_ID,
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        drive: process.env.ONEDRIVE_DRIVE_ID,
        debug: false,
      },
    ],
  },
};

export async function checkOneDrive() {
  await DI.resolve(fsService);

  const drive = getFs('onedrive');

  try {
    await drive.list('/');
  } catch (err) {
    if (err instanceof MethodNotImplemented) {
      // fsOneDrive ships no file operations; subclass it to add them.
    }
  }
}
```

## Related packages

- [`@spinajs/fs`](../fs/README.md): the `fs` base class, `fsService` that creates providers from `fs.providers`, `getFs()`, `@FileSystem()` and `FsDecorator`.
- [`@spinajs/fs-s3`](../fs-s3/README.md): a complete remote provider; read it as a reference when implementing operations in a subclass.
- `@spinajs/exceptions`: `MethodNotImplemented`, thrown by every file operation.
- `@spinajs/configuration`: loads the provider entries from `fs.providers`.
