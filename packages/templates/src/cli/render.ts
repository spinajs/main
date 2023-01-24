import { Templates } from './../index.js';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import * as path from 'path';
import * as fs from 'fs';
import { Logger, ILog } from '@spinajs/log';

interface RenderOptions {
  file?: string;
  model?: string;
  lang?: string;
}

@Command('template-render', 'Renders template, usefull for template testing')
@Argument('template', 'template path, must be in one of directory provided in configs')
@Option('-f, --file [file]', false, 'path for file, where parsing result will be saved')
@Option('-m, --model [model]', false, 'path to optional model data, passed to template, in json format')
@Option('-l, --lang [lang]', false, 'optional language. Language data must be in directories configured in intl module. If none provided, default language is used')
export class RenderTemplateCommand extends CliCommand {
  @Logger('templates')
  protected Log: ILog;

  public async execute(template: string, options: RenderOptions): Promise<void> {
    this.Log.trace(`Rendering ${template}, options: ${JSON.stringify(options)}`);

    try {
      const templates = await DI.resolve(Templates);
      let model = {};

      if (options.model && fs.existsSync(options.model)) {
        this.Log.trace(`Found model file at ${options.model}, trying to load model data ... `);

        const mText = fs.readFileSync(options.model, { encoding: 'utf-8' });
        model = JSON.parse(mText);
      }

      if (options && options.file) {
        this.Log.trace(`Rendering template to file ${options.file} ...`);

        const dir = path.dirname(options.file);

        if (!fs.existsSync(dir)) {
          this.Log.trace(`Directory ${dir} not exits, creating ...`);

          fs.mkdirSync(dir, { recursive: true });
        }

        await templates.renderToFile(template, model, options.file, options.lang);

        this.Log.success(`Rendering template ${template} to file ${options.file} succeded !`);
        return;
      }

      const result = await templates.render(template, model, options.lang);
      this.Log.success(`Rendering template ${template} succeded !`);

      // print out to console in raw format
      console.log(result);
    } catch (err) {
      this.Log.error(`Cannot render template ${template}, reason: ${err.message}, stack: ${err.stack}`);
    }
  }
}
