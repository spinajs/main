import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { DefaultControllerCache, IMethodDoc } from '@spinajs/http';
import { BaseController } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { ISwaggerCacheEntry } from './interfaces.js';

/**
 * Provides JSDoc / TypeScript-annotation documentation for controllers.
 * Delegates all TypeScript parsing to DefaultControllerCache (http package),
 * which already runs during HTTP module resolution — no extra parse pass needed.
 */
@Singleton()
export class SwaggerDocCache extends AsyncService {
  @Logger('http-swagger')
  protected Log!: Log;

  @Autoinject(DefaultControllerCache)
  protected ControllerCache!: DefaultControllerCache;

  public async resolve() {
    await super.resolve();
  }

  public async getCache(controller: ClassInfo<BaseController>): Promise<ISwaggerCacheEntry> {
    this.Log.trace(`Getting swagger doc cache for ${controller.name}`);
    const doc = await this.ControllerCache.getDocumentation(controller);

    return {
      className: doc.className,
      classDescription: doc.classDescription,
      classTags: doc.classTags,
      methods: Object.fromEntries(
        Object.entries(doc.methods).map(([name, m]: [string, IMethodDoc]) => [
          name,
          {
            summary: m.summary,
            description: m.description,
            params: m.params,
            returns: m.returns
              ? {
                  description: m.returns.description,
                  type: m.returns.type,
                  schema: m.returns.schema as any,
                }
              : undefined,
            responses: m.responses,
            examples: m.examples,
            tags: m.tags,
            deprecated: m.deprecated,
          },
        ]),
      ),
    };
  }
}
