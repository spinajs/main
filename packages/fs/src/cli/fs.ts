import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { fsService, fs } from '@spinajs/fs';
import { DI } from '@spinajs/di';

interface EmailOptions {
  name: string;
  path: string;
}

@Command('fs:describe', 'Shows all registered filesystems and their configuration')
export class FsRmCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(_options: EmailOptions): Promise<void> {
    await DI.resolve(fsService);
    const fs = DI.resolve<Map<string, fs>>('__file_provider_instance__');

    for (const n of fs.keys()) {
      const f = fs.get(n);
      this.Log.info(`Filesystem ${f.Name} is registered with configuration: ${f.}`);
    }
  }
}
