import { CliCommand, Command, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';

interface EmailOptions {
  name: string;
  path : string;
}

@Command('fs-stat', 'Deletes file from given filesystem')
@Option('-n, --name [name]', true, 'Name of filesystem to use')
@Option('-p, --path [path]', true, 'Path to file ( relative to selected fs base dir )')

export class FsRmCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(_options: EmailOptions): Promise<void> {
     
  }
}
