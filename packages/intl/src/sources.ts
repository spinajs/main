import { ILog } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { Autoinject, DI, Injectable } from '@spinajs/di';
import glob from 'glob';
import * as fs from 'fs';
import _ from 'lodash';
import { normalize, resolve, basename } from 'path';
import { Logger } from '@spinajs/log';

export abstract class TranslationSource {
  @Autoinject()
  protected Configuration: Configuration;

  @Logger('intl')
  protected Log: ILog;

  public abstract load(): Promise<{}>;
}

@Injectable(TranslationSource)
export class JsonTranslationSource extends TranslationSource {
  public async load(): Promise<{}> {
    const localeDirs = this.Configuration.get('system.dirs.locales', []);
    let translations = {};

    localeDirs
      .filter((d) => fs.existsSync(d))
      .map((d) => glob.sync(`${d}/**/*.json`.replace(/\\/g, '/')))
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      .map((f) => normalize(resolve(f)))
      .map((f) => {
        this.Log.trace(`Found json localisation file at ${f}`);
        return f;
      })
      .forEach((f) => {
        const lang = basename(f, '.json');
        let data;

        try {
          data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        } catch (ex) {
          this.Log.warn(ex, `Cannot load localisation data from file ${f} for lang ${lang}`);
          return;
        }

        if (!data) {
          this.Log.warn(`No localisation data at ${f} for lang ${lang}`);
          return;
        }

        translations = _.merge({ [lang]: data }, translations);
      });

    return translations;
  }
}

@Injectable(TranslationSource)
export class JsTranslationSource extends TranslationSource {
  public async load(): Promise<{}> {
    const localeDirs = this.Configuration.get('system.dirs.locales', []);
    let translations = {};

    const files = localeDirs
      .filter((d) => fs.existsSync(d))
      .map((d) => glob.sync(`${d}/**/*.{js,cjs}`.replace(/\\/g, '/')))
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      .map((f) => normalize(resolve(f)))
      .map((f) => {
        this.Log.trace(`Found json localisation file at ${f}`);
        return f;
      });

    for (const f of files) {
      const lang = basename(basename(f, '.js'), '.cjs');
      let data = await DI.__spinajs_require__(f);

      if (!data) {
        this.Log.warn(`No localisation data at ${f} for lang ${lang}`);
        return;
      }

      translations = _.merge({ [lang]: data }, translations);
    }

    return translations;
  }
}
