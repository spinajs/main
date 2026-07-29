import { CliCommand, Command, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { ClassInfo, DI } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';
import { fsService } from '@spinajs/fs';
import { uniqueBy } from '@spinajs/util';
import { DefaultControllerCache, isOnDiskSource } from '../cache.js';
import { ControllerSource } from '../controller-sources.js';
import { BaseController } from '../base-controller.js';

interface IControllersCacheOptions {
  rebuild?: boolean;
}

/**
 * Pre-builds the controller parameter + documentation cache so a deployed app
 * (e.g. a docker image) does not pay the TypeScript-parsing cost on first
 * start. Default behavior only generates missing entries; `--rebuild` forces
 * regeneration of existing ones.
 *
 * Exits non-zero when any controller fails, so image builds fail loudly.
 */
@Command('http:controllers:cache', 'generate controllers cache ahead of time ( eg. during docker image build )')
@Option('-r, --rebuild', false, 'regenerate cache entries even if they already exist')
export class ControllersCacheCommand extends CliCommand {
  @Logger('http')
  protected Log: Log;

  public async execute(options: IControllersCacheOptions): Promise<void> {
    await DI.resolve(fsService);

    const rebuild = options?.rebuild === true;
    const cache = await DI.resolve(DefaultControllerCache);

    // Same discovery the runtime loader uses — filesystem scan, DI registry
    // and any custom ControllerSource an app registers.
    const sources = (await DI.resolve(Array.ofType(ControllerSource))) as ControllerSource[];
    const discovered = (await Promise.all(sources.map((s) => s.getControllers()))).flat();

    // Only entries with a parsable on-disk source. Sentinel entries ( `<di>` )
    // have no file to parse, and the runtime fallback needs a resolved
    // controller instance which a CLI run does not create.
    const controllers = uniqueBy(
      discovered.filter((c: ClassInfo<BaseController>) => isOnDiskSource(c.file)),
      (c) => c.name,
    );

    this.Log.info(`Generating controllers cache for ${controllers.length} controllers ( rebuild: ${rebuild} ) ...`);

    const failed: string[] = [];
    for (const c of controllers) {
      try {
        await cache.getCache(c, { rebuild });
      } catch (err) {
        failed.push(c.name);
        this.Log.error(`Failed to generate cache for controller ${c.name} ( ${c.file} ): ${(err as Error).message}`);
      }
    }

    this.Log.info(`Controllers cache done: ${controllers.length - failed.length} ok, ${failed.length} failed`);

    if (failed.length > 0) {
      throw new Exception(`Controllers cache generation failed for: ${failed.join(', ')}`);
    }
  }
}
