import { Config } from '@spinajs/configuration';
import { AsyncModule } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { join, normalize, resolve } from 'path';
import { glob } from 'glob';
import _ from 'lodash';

export abstract class TemplateRenderer extends AsyncModule {
  @Logger('renderer')
  protected Log: Log;

  @Config('system.dirs.templates')
  protected TemplatePaths: string[];

  protected TemplateFiles: Map<string, string[]> = new Map<string, string[]>();

  public abstract get Type(): string;

  public abstract get Extension(): string;

  public abstract render(templatePath: string, model: unknown, language?: string): Promise<string>;
  public abstract renderToFile(templatePath: string, model: unknown, filePath: string, language?: string): Promise<void>;
  protected abstract compile(templateName: string, path: string): Promise<void>;

  public async resolveAsync(): Promise<void> {
    for (const path of this.TemplatePaths) {
      const files = glob
        .sync(join(path, `/**/${this.Extension}`))
        .map((f) => normalize(resolve(f)))
        .filter((v: any) => v !== null);

      for (const file of files) {
        const templateName = file.substring(path.length, file.length);
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
      await this.compile(templateName, path[path.length - 1]);

      this.Log.trace(`Compiling template ${templateName}, at path ${path[path.length - 1]} finished`);
    }
  }
}
