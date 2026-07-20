import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _stat } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-stat', 'Prints statistics for a file or directory')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to stat ( relative to selected fs base dir )')
export class FsStatCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      const stat = await _stat(path, fsName);
      this.Log.info(`Stat for ${path} ( fs: ${fsName} ):`);
      this.Log.info(`  type: ${stat.IsDirectory ? 'directory' : 'file'}`);
      this.Log.info(`  size: ${stat.Size ?? 'n/a'} bytes`);
      this.Log.info(`  created:  ${stat.CreationTime?.toISO() ?? 'n/a'}`);
      this.Log.info(`  modified: ${stat.ModifiedTime?.toISO() ?? 'n/a'}`);
      this.Log.info(`  accessed: ${stat.AccessTime?.toISO() ?? 'n/a'}`);
    } catch (err) {
      this.Log.error(`Cannot stat ${path} on ${fsName}: ${err.message}`);
    }
  }
}
