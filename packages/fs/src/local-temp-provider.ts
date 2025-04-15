import { IFsLocalTempOptions } from './interfaces.js';
import { fsNative } from './local-provider.js';
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';

/**
 * Default file age for temp files in seconds
 */
const DEFAULT_FILE_AGE = 60 * 60;

/**
 * Native temp filesystem. Use it for creating and storing temporary files and dirs.
 *
 * It will automatically delete old files. It does not check fieles recursive in subdirectories.
 * It only check for file/dir age at first level.
 */
@Injectable('fs')
export class fsNativeTemp extends fsNative<IFsLocalTempOptions> {
  /**
   * timer instance used to cleanup old temp files
   */
  protected cleanupTimer: NodeJS.Timeout;

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

    this.Logger.info(
      `Starting cleanup timer for temporary files system ${this.Options.name}, interval: ${this.Options.cleanupInterval}, max file age: ${this.Options.maxFileAge}`,
    );

    this.cleanupTimer = setInterval(async () => {
      const files = await this.list('/');
      const today = DateTime.now();

      for (const f of files) {
        const stat = await this.stat(f);
        const timeDiff = today.diff(stat.CreationTime, 'seconds');

        if (timeDiff.seconds > (this.Options.maxFileAge || DEFAULT_FILE_AGE)) {
          this.Logger.trace(
            `Temp file at path ${f} is older than ${
              this.Options.maxFileAge
            } seconds, ( CreatedAt: ${stat.CreationTime.toFormat('dd/MM/yyyy HH:mm:ss')} ), deleting...`,
          );

          await this.rm(f);
        }
      }
    }, this.Options.cleanupInterval || 10 * 60 * 1000);
  }
}
