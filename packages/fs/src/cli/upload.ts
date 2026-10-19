import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _upload } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-upload', 'Uploads a local file into a filesystem')
@Argument('fs', true, 'Destination filesystem name')
@Argument('src', true, 'Local source file ( absolute path )')
@Argument('dst', false, 'Destination path ( defaults to source file name )')
export class FsUploadCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, src: string, dst?: string): Promise<void> {
    await ensureProviders();

    try {
      await _upload(src, dst, fsName);
      this.Log.success({ src, dst: dst ?? '( basename )', fsName }, 'Uploaded ${src} -> ${dst} ( fs: ${fsName} )');
    } catch (err) {
      this.Log.error({ error: err, src, fsName }, 'Cannot upload ${src} to ${fsName}');
      process.exitCode = 1;
    }
  }
}
