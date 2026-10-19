import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

// Not under authz.fs: that section is keyed by filesystem name.
export const FS_METADATA_CONNECTION_KEY = 'authz.fsMetadata.connection';

export const FS_METADATA_DEFAULT_CONNECTION = 'default';

/** The ORM connection of OrmFileMetadataStore and of its migration: `authz.fsMetadata.connection`, else the default one. */
export function fsMetadataConnection(container: IContainer = DI.RootContainer): string {
  const configuration = container.get(Configuration) as Configuration | undefined;
  return (configuration?.get?.(['authz', 'fsMetadata', 'connection']) as string | null | undefined) ?? FS_METADATA_DEFAULT_CONNECTION;
}
