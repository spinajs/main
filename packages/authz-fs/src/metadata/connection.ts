import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

// Not under authz.fs: that section is keyed by filesystem name.
export const FS_METADATA_CONNECTION_KEY = 'authz.fsMetadata.connection';

/** The ORM connection of OrmFileMetadataStore and of its migration: `authz.fsMetadata.connection`, else 'default'. */
export function fsMetadataConnection(container: IContainer = DI.RootContainer): string {
  const configuration = container.get(Configuration) as Configuration | undefined;
  const configured: unknown = configuration?.get?.(['authz', 'fsMetadata', 'connection']);
  if (configured === undefined || configured === null) return 'default';
  if (typeof configured !== 'string' || configured === '') throw new AuthzConfigError(`configuration key ${FS_METADATA_CONNECTION_KEY} must be a connection name, got ${JSON.stringify(configured)}`);
  return configured;
}
