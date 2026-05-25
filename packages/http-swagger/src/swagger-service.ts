import { AsyncService, Autoinject, LazyInject, Singleton } from '@spinajs/di';
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

  private _spec: IOpenApiDocument | null = null;

  public get IsEnabled(): boolean {
    return this.SwaggerConfig?.enabled !== false;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
  }

  public async getSpec(): Promise<IOpenApiDocument | null> {
    if (!this.IsEnabled) return null;
    if (!this._spec) {
      this.Log.info('Building Swagger/OpenAPI documentation...');
      const spec = await this.buildSpec();
      this.Log.info(`Swagger documentation ready. ${Object.keys(spec.paths ?? {}).length} paths documented.`);
    }
    return this._spec;
  }

  /**
   * Rebuild the OpenAPI specification from current controllers.
   */
  public async buildSpec(): Promise<IOpenApiDocument> {
    const config = this.SwaggerConfig || {
      enabled: true,
      title: 'API Documentation',
      version: '1.0.0',
    };

    const builder = new OpenApiBuilder(config);
    const controllers = await this.ControllersService.Controllers;

    for (const controller of controllers) {
      try {
        const docCache = await this.DocCache.getCache(controller);
        builder.addController(controller, docCache);
      } catch (err) {
        this.Log.warn(`Failed to process controller ${controller.name}: ${err}`);
      }
    }

    this._spec = builder.build();
    return this._spec;
  }
}
