import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

/** The ORM connection alias of fs_object; an app maps it with `db.Aliases['authz-fs']` (package default: `default`). */
export const FS_METADATA_CONNECTION = 'authz-fs';

/** Fails on the key the alias replaced, so an app's choice of database is never ignored. */
export function checkRemovedFsMetadataKeys(container: IContainer): void {
  const configuration = container.get(Configuration) as Configuration | undefined;
  if (configuration?.get?.(['authz', 'fsMetadata', 'connection']) === undefined) return;
  throw new AuthzConfigError(`authz.fsMetadata.connection: removed; fs_object uses the ORM connection alias "${FS_METADATA_CONNECTION}", so set db.Aliases['${FS_METADATA_CONNECTION}'] to the connection name instead (default: "default")`);
}
