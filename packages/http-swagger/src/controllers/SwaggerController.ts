import { Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Ok, TemplateResponse } from '@spinajs/http';
import { SwaggerService } from '../swagger-service.js';
import { ISwaggerUiConfig } from '../interfaces.js';

/**
 * Controller that serves Swagger/OpenAPI documentation.
 * Provides the OpenAPI JSON spec and a Swagger UI interface.
 */
@BasePath('docs')
export class SwaggerController extends BaseController {
  @Autoinject()
  protected Swagger!: SwaggerService;

  @Config('http.swagger.ui')
  protected UiConfig!: ISwaggerUiConfig;

  /**
   * Returns the OpenAPI 3.0 JSON specification.
   * @returns OpenAPI specification document
   */
  @Get('swagger.json')
  public async getSpec() {
    if (!this.Swagger.IsEnabled) {
      return new Ok({ error: 'Swagger documentation is disabled' });
    }

    return new Ok(this.Swagger.Spec);
  }

  /**
   * Serves the Swagger UI HTML page rendered via Pug template.
   * @returns HTML page with Swagger UI
   */
  @Get('/')
  public async getUI() {
    if (!this.Swagger.IsEnabled) {
      return new Ok({ error: 'Swagger documentation is disabled' });
    }

    const cfg: Partial<ISwaggerUiConfig> = this.UiConfig || {};

    return new TemplateResponse(
      { template: 'swagger.pug', provider: '__fs_swagger_views__' },
      {
        title: cfg.pageTitle || this.Swagger.Spec?.info?.title || 'API Documentation',
        cssUrl: cfg.cssUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css',
        bundleUrl: cfg.bundleUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js',
        presetUrl: cfg.presetUrl || 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js',
        specUrl: cfg.specUrl || '/docs/swagger.json',
      },
    );
  }
}
