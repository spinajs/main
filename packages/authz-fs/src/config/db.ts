import { ConfigVar, Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

// Package config merges before the app's, so an app's db.Aliases['authz-fs-acl'] wins. The alias follows the key the
// migrations read. A ConfigVar keeps its first truthy value: before the Configuration is cached it answers nothing.
const fsAclConnection = {
  db: {
    Aliases: {
      'authz-fs-acl': new ConfigVar(() => {
        const configuration = DI.get<Configuration>(Configuration);
        return configuration ? (configuration.get<string>('authz.fsAcl.connection') ?? 'default') : undefined;
      }),
    },
  },
};

export default fsAclConnection;
