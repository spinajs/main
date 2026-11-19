import { existsSync } from 'fs';
import { dirname } from 'path';
import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Json, NotFound, TemplateResponse } from '@spinajs/http';
import type { IControllerDescriptor, IHttpStaticFileConfiguration } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { SwaggerService } from '../swagger-service.js';
import { ISwaggerUiConfig } from '../interfaces.js';
import { AllowAnonymous } from '../access.js';

/**
 * Controller that serves Swagger/OpenAPI documentation.
 * Provides the OpenAPI JSON spec and a Swagger UI interface.
 */
@BasePath('docs')
@AllowAnonymous()
export class SwaggerController extends BaseController {
  @Autoinject()
  protected Swagger!: SwaggerService;

  @Config('http.swagger.ui')
  protected UiConfig!: ISwaggerUiConfig;

  @Logger('http-swagger')
  protected Log!: Log;

  /** http mounts every controller it finds, so disabled docs hide their routes instead of answering 404 from them. */
  public get Descriptor(): IControllerDescriptor {
    const descriptor = super.Descriptor;
    return this.Swagger.IsEnabled ? descriptor : { ...descriptor, Routes: new Map() };
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    this.warnMissingUiDist();
  }

  /** The package config leaves `/docs/ui` unmounted, without http's generic warning, when swagger-ui-dist is missing. */
  private warnMissingUiDist(): void {
    if (!this.Swagger.IsEnabled || this._cfg.get<unknown>('http.swagger.enabled', true) === false) return;

    // Config arrays concatenate: an app's own /docs/ui entry comes after the package's, which stays in the list.
    const entries = this._cfg.get<IHttpStaticFileConfiguration[]>('http.Static', []).filter((s) => s.Route === '/docs/ui');
    const { cssUrl, bundleUrl, presetUrl } = this.UiConfig ?? {};
    const loadsFromUi = [cssUrl, bundleUrl, presetUrl].some((url) => typeof url === 'string' && url.startsWith('/docs/ui/'));
    if (entries.length === 0 || !loadsFromUi || entries.some((s) => s.Enabled !== false && existsSync(s.Path))) return;

    // The package's entry: the walk from <root> upwards found nothing, so it holds <root>/node_modules/swagger-ui-dist.
    const path = entries[0].Path;
    this.Log.warn(
      { path, root: dirname(dirname(path)) },
      'swagger-ui-dist is not installed: it was looked for in every node_modules folder from ${root} upwards and not found (default path ${path}), ' +
        'so /docs/ui serves nothing and the Swagger UI page at /docs/ cannot load its stylesheet and scripts. ' +
        'Install it with npm install swagger-ui-dist, or set http.swagger.ui.cssUrl, bundleUrl and presetUrl to the CDN files under https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/.',
    );
  }

  /**
   * Returns the OpenAPI 3.0 JSON specification.
   * @returns OpenAPI specification document
   */
  @Get('swagger.json')
  public async getSpec() {
    if (!this.Swagger.IsEnabled) {
      return new NotFound({ error: 'Swagger documentation is disabled' });
    }

    return new Json(await this.Swagger.getSpec());
  }

  /**
   * Serves the Swagger UI HTML page rendered via Pug template.
   * @returns HTML page with Swagger UI
   */
  @Get('/')
  public async getUI() {
    if (!this.Swagger.IsEnabled) {
      return new NotFound({ error: 'Swagger documentation is disabled' });
    }

    const cfg: Partial<ISwaggerUiConfig> = this.UiConfig || {};

    return new TemplateResponse(
      { template: 'swagger.pug', provider: '__fs_swagger_views__' },
      {
        title: cfg.pageTitle || (await this.Swagger.getSpec())?.info?.title || 'API Documentation',
        cssUrl: cfg.cssUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css',
        bundleUrl: cfg.bundleUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js',
        presetUrl: cfg.presetUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js',
        specUrl: cfg.specUrl || '/docs/swagger.json',
      },
    );
  }
}
