import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { readFileSync } from 'fs';
import { InvalidArgument } from '@spinajs/exceptions';
import { _write } from '../fp.js';
import { ensureProviders } from './fs.js';

interface WriteOptions {
  content?: string;
  fromFile?: string;
  encoding: BufferEncoding;
}

@Command('fs-write', 'Writes content to a file ( from inline text or a local file )')
@Argument('fs', true, 'Destination filesystem name')
@Argument('path', true, 'Path to file ( relative to selected fs base dir )')
@Option('-c, --content <content>', false, 'Inline text content to write')
@Option('-f, --from-file <fromFile>', false, 'Local file whose content will be written')
@Option('-e, --encoding <encoding>', false, 'Encoding used for inline content', 'utf-8')
export class FsWriteCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string, options: WriteOptions): Promise<void> {
    await ensureProviders();

    try {
      if (options.fromFile) {
        // binary-safe: read as buffer and write without re-encoding
        const data = readFileSync(options.fromFile);
        await _write(path, data, undefined, fsName);
      } else if (options.content !== undefined) {
        await _write(path, options.content, options.encoding, fsName);
      } else {
        throw new InvalidArgument('Provide content with --content or --from-file');
      }

      this.Log.success(`Wrote ${path} ( fs: ${fsName} )`);
    } catch (err) {
      this.Log.error(`Cannot write ${path} on ${fsName}: ${err.message}`);
    }
  }
}
