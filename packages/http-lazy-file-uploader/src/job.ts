import { IOFail } from '@spinajs/exceptions';
import { fs, getFs } from '@spinajs/fs';
import { Log, Logger } from '@spinajs/log-common';
import { QueueJob, Job } from '@spinajs/queue';

@Job({ runAs: 'initiator' })
export class LazyUploadJob extends QueueJob {
  @Logger('LazyUploadJob')
  protected Log: Log;

  // Filesystem to upload to
  public ToFilesystem: string;

  public Path: string;

  public SourceFilesystem: string;

  /**
   * Should source file be deleted after upload
   */
  public DeleteAfterUpload: boolean;

  public async execute(progress: (p: number) => Promise<void>) {
    this.Log.info(
      { path: this.Path, sourceFs: this.SourceFilesystem, targetFs: this.ToFilesystem, deleteAfterUpload: this.DeleteAfterUpload },
      'COPY: ${path}, fs: ${sourceFs} dst: ${targetFs}, deleteAfterUpload: ${deleteAfterUpload}',
    );

    const sFs = this.getFilesystem(this.SourceFilesystem);
    const tFs = this.getFilesystem(this.ToFilesystem);

    this.Log.timeStart(`[COPY] ${this.Path}`);

    await progress(0);

    await sFs.copy(this.Path, this.Path, tFs);

    if (this.DeleteAfterUpload) {
      await sFs.rm(this.Path);
    }

    await progress(100);

    const d = this.Log.timeEnd(`[COPY] ${this.Path}`);
    this.Log.trace({ path: this.Path, sourceFs: this.SourceFilesystem, targetFs: this.ToFilesystem, ms: d }, 'Copied ${path} from ${sourceFs} to ${targetFs} in ${ms}ms');

    return 'finished';
  }

  protected getFilesystem(name: string) {
    let provider: fs | undefined;

    try {
      provider = getFs(name);
    } catch (err) {
      throw new IOFail(`Filesystem ${name} not exists, pleas check your configuration`, err);
    }

    if (!provider) {
      throw new IOFail(`Filesystem ${name} not exists, pleas check your configuration`);
    }

    return provider;
  }
}
