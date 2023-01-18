import { IMappableService } from './../../di/src/interfaces';
import { Config } from '@spinajs/configuration';
import { AsyncService } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { join } from 'path';
import { glob } from 'glob';
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

  public async resolve(): Promise<void> {
    for (const path of this.TemplatePaths) {
      const files = glob.sync(join(path, `/**/*${this.Extension}`));

      for (const file of files) {
        const templateName = file.substring(path.length + 1, file.length);
        if (this.TemplateFiles.has(templateName)) {
          this.Log.trace(`Template ${templateName} is overriden by ${file}`);
          this.TemplateFiles.get(templateName).push(file);
        } else {
          this.Log.trace(`Found template ${templateName} file at path ${file}`);
          this.TemplateFiles.set(templateName, [file]);
        }
      }
    }

    for (const [templateName, path] of this.TemplateFiles) {
      if (path.length === 0) {
        this.Log.warn(`Template ${templateName} don't have any files`);
        continue;
      }

      this.Log.trace(`Compiling template ${templateName}, at path ${path[path.length - 1]}`);

      // compile only last template ( newest )
      // templates can be overriden by other modules / libs
      // or app
      try {
        await this.compile(templateName, path[path.length - 1]);
      } catch (err) {
        this.Log.error(`Cannot compile template ${templateName} with file ${path[path.length - 1]}, reason: ${JSON.stringify(err)}`);

        continue;
      }

      this.Log.trace(`Compiling template ${templateName}, at path ${path[path.length - 1]} finished`);
    }
  }
}
