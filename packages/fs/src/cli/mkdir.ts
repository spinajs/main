import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _mkdir } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-mkdir', 'Creates a directory ( recursively ) in a filesystem')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Directory path to create ( relative to selected fs base dir )')
export class FsMkdirCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      await _mkdir(path, fsName);
      this.Log.success(`Created directory ${path} on filesystem ${fsName}`);
    } catch (err) {
      this.Log.error(`Cannot create directory ${path} on ${fsName}: ${err.message}`);
    }
  }
}
