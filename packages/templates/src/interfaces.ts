import { IMappableService } from '@spinajs/di';
import { AsyncService } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';

export abstract class TemplateRenderer extends AsyncService implements IMappableService {
  @Logger('renderer')
  protected Log: Log;

  public abstract get Type(): string;

  public abstract get Extension(): string;

  public get ServiceName() {
    // we map this service by extension
    return this.Extension;
  }

  public abstract render(templatePath: string, model: unknown, language?: string): Promise<string>;
  public abstract renderToFile(templatePath: string, model: unknown, filePath: string, language?: string): Promise<void>;

  /**
   * Precompiles a template at the given path. Called lazily by engines that cache
   * compiled templates (pug, handlebars). Engines with no compile step (csv, xlsx,
   * puppeteer, mjml) inherit this no-op default.
   *
   * @param path - full path to the template file
   */
  protected compile(_path: string): Promise<void> {
    return Promise.resolve();
  }
}
