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
      console.log(`type: ${stat.IsDirectory ? 'directory' : 'file'}`);
      console.log(`size: ${stat.Size ?? 'n/a'} bytes`);
      console.log(`created:  ${stat.CreationTime?.toISO() ?? 'n/a'}`);
      console.log(`modified: ${stat.ModifiedTime?.toISO() ?? 'n/a'}`);
      console.log(`accessed: ${stat.AccessTime?.toISO() ?? 'n/a'}`);
    } catch (err) {
      this.Log.error({ error: err, path, fsName }, 'Cannot stat ${path} on ${fsName}');
      process.exitCode = 1;
    }
  }
}
