import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { DI } from '@spinajs/di';
import { fs, fsService } from '../index.js';

/**
 * Ensures fs providers are registered ( resolves fsService once if the app
 * has not bootstrapped it yet ).
 */
export async function ensureProviders(): Promise<void> {
  if (!DI.get('__file_provider_instance__')) {
    await DI.resolve(fsService);
  }
}

@Command('fs-describe', 'Lists all registered filesystems and their provider type')
export class FsDescribeCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(): Promise<void> {
    await ensureProviders();

    const providers = DI.get<Map<string, fs>>('__file_provider_instance__');

    if (!providers || providers.size === 0) {
      this.Log.warn('No filesystems registered, check your fs configuration');
      return;
    }

    for (const [name, provider] of providers) {
      this.Log.info(`Filesystem '${name}' ( service: ${provider.constructor.name} )`);
    }
  }
}
