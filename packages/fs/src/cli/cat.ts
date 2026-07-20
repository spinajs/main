import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _read } from '../fp.js';
import { ensureProviders } from './fs.js';

interface CatOptions {
  encoding: BufferEncoding;
}

@Command('fs-cat', 'Prints content of a file to the console')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to file ( relative to selected fs base dir )')
@Option('-e, --encoding <encoding>', false, 'Encoding used to read the file', 'utf-8')
export class FsCatCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string, options: CatOptions): Promise<void> {
    await ensureProviders();

    try {
      const content = await _read(path, options.encoding, fsName);
      this.Log.info(content.toString());
    } catch (err) {
      this.Log.error(`Cannot read ${path} on ${fsName}: ${err.message}`);
    }
  }
}
