import { CliCommand, Command, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';

interface FsStatOptions {
  name?: string;
}

@Command('fs-stat', 'Gets statistics for filesystem(s)')
@Option('-n, --name [name]', false, 'Name of filesystem. If not set, all avaible fs are listed')
export class FsStatCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(_options: FsStatOptions): Promise<void> {}
}
