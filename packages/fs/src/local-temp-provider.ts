import { IFsLocalTempOptions } from './interfaces.js';
import { fsNative } from './local-provider.js';
import { DateTime } from 'luxon';

/**
 * Native temp filesystem. Use it for creating and storing temporary files and dirs.
 *
 * It will automatically delete old files. It does not check fieles recursive in subdirectories.
 * It only check for file/dir age at first level.
 */
export class fsNativeTemp extends fsNative<IFsLocalTempOptions> {
  /**
   * timer instance used to cleanup old temp files
   */
  protected cleanupTimer: NodeJS.Timer;

  constructor(options: IFsLocalTempOptions) {
    super(options);
  }

  public async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  public async resolve() {
    await super.resolve();

    if (!this.Options.cleanup) {
      this.Logger.info(
        `Cleanup for temporary files system ${this.Options.name} set to false. Check configuration file if you want to automatically clenaup temporary files.`,
      );
    }

    this.cleanupTimer = setInterval(async () => {
      const files = await this.list('/');
      const today = DateTime.now();

      for (const f of files) {
        const stat = await this.stat(f);
        const timeDiff = stat.CreationTime.diff(today, 'seconds');

        if (Math.abs(timeDiff.seconds) > this.Options.cleanupInterval) {
          this.Logger.trace(
            `Temp file at path ${f} is older than ${
              this.Options.cleanupInterval
            } ( CreatedAt: ${stat.CreationTime.toFormat('dd/MM/yyyy HH:mm:ss')} ), deleting...`,
          );

          await this.rm(f);
        }
      }
    }, this.Options.cleanupInterval || 10 * 60 * 1000);
  }
}
