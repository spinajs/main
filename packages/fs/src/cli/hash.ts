import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _hash } from '../fp.js';
import { ensureProviders } from './fs.js';

interface HashOptions {
  algo?: string;
}

@Command('fs-hash', 'Calculates and prints the hash of a file')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to file ( relative to selected fs base dir )')
@Option('-a, --algo <algo>', false, 'Hash algorithm ( default sha256 )')
export class FsHashCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string, options: HashOptions): Promise<void> {
    await ensureProviders();

    try {
      const hash = await _hash(path, options.algo, fsName);
      this.Log.info(`${options.algo ?? 'sha256'}(${path}) = ${hash}`);
    } catch (err) {
      this.Log.error(`Cannot hash ${path} on ${fsName}: ${err.message}`);
    }
  }
}
