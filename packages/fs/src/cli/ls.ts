import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _list } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-ls', 'Lists content of a directory in a filesystem')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', false, 'Directory to list ( defaults to fs root )')
export class FsLsCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path?: string): Promise<void> {
    await ensureProviders();

    try {
      const entries = await _list(path ?? '/', fsName);
      this.Log.info(`${entries.length} entries in ${path ?? '/'} ( fs: ${fsName} ):`);
      entries.forEach((e) => this.Log.info(`  ${e}`));
    } catch (err) {
      this.Log.error(`Cannot list ${path ?? '/'} on ${fsName}: ${err.message}`);
    }
  }
}
