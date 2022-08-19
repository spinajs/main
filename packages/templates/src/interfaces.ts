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

  protected TemplateFiles: string[];

  public abstract get Type(): string;

  public abstract get Extension(): string;

  abstract render(template: string, model: unknown, language?: string): Promise<string>;
  abstract renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void>;

  public async resolveAsync(): Promise<void> {
    this.TemplateFiles = this.TemplatePaths.map((x) => glob.sync(join(x, `/**/${this.Extension}`)))
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      .map((f: string) => normalize(resolve(f)))
      .filter((v: any) => v !== null)
      .filter((f: string, index: number, self: any[]) => self.indexOf(f) === index);

    this.TemplateFiles.forEach((f) => {
      this.Log.trace(`Found template file at path ${f}`);
    });
  }
}
