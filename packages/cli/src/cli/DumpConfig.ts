import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Option } from '../index.js';
import { Configuration } from '@spinajs/configuration-common';
import { Autoinject } from '@spinajs/di';

interface DumpConfigOptions {
  path?: string;
}

@Command('configuration:dump', 'Dumps configuration')
@Option('-p, --path <path>', false, 'configuration path')
export class DumpConfiguration extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  @Autoinject()
  protected Config: Configuration;

  public async execute(options: DumpConfigOptions): Promise<void> {
    this.Log.info(JSON.stringify(options.path ? this.Config.RootConfig : this.Config.get(options.path)));
  }
}
