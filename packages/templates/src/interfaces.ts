import { IMappableService } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AsyncService } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import _ from 'lodash';

export abstract class TemplateRenderer extends AsyncService implements IMappableService {
  @Logger('renderer')
  protected Log: Log;

  @Config('system.dirs.templates', { defaultValue: [] })
  protected TemplatePaths: string[];

  protected TemplateFiles: Map<string, string[]> = new Map<string, string[]>();

  public abstract get Type(): string;

  public abstract get Extension(): string;

  public get ServiceName() {
    // we map this service by extension
    return this.Extension;
  }

  public abstract render(templatePath: string, model: unknown, language?: string): Promise<string>;
  public abstract renderToFile(templatePath: string, model: unknown, filePath: string, language?: string): Promise<void>;

  /**
   * Function used for precompiling templates at load time. Not all template engines can support it, leave it empty if so.
   *
   * @param templateName - template name
   * @param path - template full path
   */
  protected abstract compile(templateName: string, path: string): Promise<void>;
}
