import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _download } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-download', 'Downloads a file to local storage and prints the local path')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to file ( relative to selected fs base dir )')
export class FsDownloadCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      const local = await _download(path, fsName);
      this.Log.success(`Downloaded ${path} ( fs: ${fsName} ) -> ${local}`);
    } catch (err) {
      this.Log.error(`Cannot download ${path} from ${fsName}: ${err.message}`);
    }
  }
}
