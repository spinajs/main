import { AsyncService, Autoinject, DI, LazyInject, Singleton } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { Controllers } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { SwaggerDocCache } from './swagger-cache.js';
import { OpenApiBuilder } from './openapi-builder.js';
import { ISwaggerConfig, IOpenApiDocument } from './interfaces.js';

/**
 * Main Swagger/OpenAPI service.
 * Orchestrates building the OpenAPI spec from loaded controllers and their JSDoc documentation.
 */
@Singleton()
export class SwaggerService extends AsyncService {
  @Logger('http-swagger')
  protected Log!: Log;

  @LazyInject()
  protected ControllersService!: Controllers;

  @Autoinject()
  protected DocCache!: SwaggerDocCache;

  @Config('http.swagger')
  protected SwaggerConfig!: ISwaggerConfig;

  /**
   * The global route prefix the runtime prepends to every controller route
   * (see BaseController route registration). Documented paths must include it
   * or Swagger "Try it out" hits the wrong URL. Only used as a fallback when
   * an explicit swagger.basePath isn't configured.
   */
  @Config('http.controllers.route.prefix', { defaultValue: '' })
  protected RoutePrefix!: string;

  private _spec: IOpenApiDocument | null = null;

  /**
   * In-flight build, shared so concurrent first requests don't each kick off a
   * full (expensive) rebuild. Cleared once the build settles.
   */
  private _buildPromise: Promise<IOpenApiDocument> | null = null;

  public get IsEnabled(): boolean {
    return this.SwaggerConfig?.enabled !== false;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
  }

  /**
   * Drop the cached spec so the next getSpec() rebuilds it. Call after
   * registering controllers at runtime (Controllers.add) so they appear in
   * the documentation.
   */
  public invalidate(): void {
    this._spec = null;
    this._buildPromise = null;
  }

  public async getSpec(): Promise<IOpenApiDocument | null> {
    if (!this.IsEnabled) return null;
    if (this._spec) return this._spec;

    // Coalesce concurrent builds onto a single in-flight promise.
    if (!this._buildPromise) {
      this.Log.info('Building Swagger/OpenAPI documentation...');
      const build: Promise<IOpenApiDocument> = this.buildSpec()
        .then((spec) => {
          this.Log.info({ paths: Object.keys(spec.paths ?? {}).length }, 'Swagger documentation ready. ${paths} paths documented.');

          // A build superseded by invalidate() is stale: serve it to its waiters, never cache it.
          if (this._buildPromise === build) {
            this._spec = spec;
          } else if (this._spec === spec) {
            this._spec = null;
          }

          return spec;
        })
        .finally(() => {
          if (this._buildPromise === build) {
            this._buildPromise = null;
          }
        });
      this._buildPromise = build;
    }

    return this._buildPromise;
  }

  /**
   * Rebuild the OpenAPI specification from current controllers.
   */
  public async buildSpec(): Promise<IOpenApiDocument> {
    const baseConfig = this.SwaggerConfig || {
      enabled: true,
      title: 'API Documentation',
      version: '1.0.0',
    };

    // Fall back to the runtime route prefix so documented paths match the
    // actual mounted URLs when no explicit swagger.basePath is set.
    const config = {
      ...baseConfig,
      basePath: baseConfig.basePath || this.RoutePrefix || '',
    };

    const builder = await DI.resolve(OpenApiBuilder, [config]);
    const controllers = await this.ControllersService.Controllers;

    // Every controller is attempted before anything is thrown, so one run reports EVERY
    // offender. Aborting on the first one hides the rest: the builder already stops at a
    // controller's first bad method, and when these failures were only warned about, seven
    // log lines stood for thirteen broken arguments - and the twenty-one operations of the
    // controllers that failed silently vanished from a spec that still answered 200.
    const failures: { controller: string; error: string }[] = [];

    for (const controller of controllers) {
      try {
        const docCache = await this.DocCache.getCache(controller);
        builder.addController(controller, docCache);
      } catch (err) {
        failures.push({ controller: controller.name, error: (err as Error)?.message ?? String(err) });
      }
    }

    if (failures.length > 0) {
      // A controller that cannot be documented is a controller that is wrong - it is fixed,
      // not worked around. Omitting it would publish a spec that looks complete and is not,
      // which is precisely the failure this replaces.
      this.Log.error({ count: failures.length, failures }, 'Cannot build the OpenAPI spec: ${count} controller(s) could not be documented: ${failures}');
      throw new UnexpectedServerError(
        `Cannot build the OpenAPI spec: ${failures.length} controller(s) could not be documented.\n${failures.map((f) => `  - ${f.controller}: ${f.error}`).join('\n')}`,
      );
    }

    this._spec = builder.build();
    return this._spec;
  }
}
