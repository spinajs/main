 import { DI, Injectable } from '@spinajs/di';
import * as fs from 'fs';
import _ from 'lodash';
import { normalize, resolve, basename } from 'path';
import { TranslationSource } from "./interfaces.js";

/** One glob per existing dir; glob is imported only when there is one. */
async function globIn(dirs: string[], pattern: string): Promise<string[][]> {
  const existing = dirs.filter((d) => fs.existsSync(d));
  if (existing.length === 0) return [];
  const { default: glob } = await import('glob');
  return existing.map((d) => glob.sync(`${d}/**/${pattern}`.replace(/\\/g, '/')));
}


@Injectable(TranslationSource)
export class JsonTranslationSource extends TranslationSource {
  public async load(): Promise<{}> {
    const localeDirs = this.Configuration.get('system.dirs.locales', []);
    let translations = {};

    (await globIn(localeDirs, '*.json'))
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      .map((f) => normalize(resolve(f)))
      .map((f) => {
        this.Log.trace({ file: f }, 'Found json localisation file at ${file}');
        return f;
      })
      .forEach((f) => {
        const lang = basename(f, '.json');
        let data;

        try {
          data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        } catch (ex) {
          this.Log.warn({ error: ex, file: f, lang }, 'Cannot load localisation data from file ${file} for lang ${lang}');
          return;
        }

        if (!data) {
          this.Log.warn({ file: f, lang }, 'No localisation data at ${file} for lang ${lang}');
          return;
        }

        translations = _.merge({ [lang]: (data as any)[lang] ?? data }, translations);
      });

    return translations;
  }
}

@Injectable(TranslationSource)
export class JsTranslationSource extends TranslationSource {
  public async load(): Promise<{}> {
    const localeDirs = this.Configuration.get('system.dirs.locales', []);
    let translations = {};

    const files = (await globIn(localeDirs, '*.{js,cjs}'))
      .reduce((prev, current) => {
        return prev.concat(_.flattenDeep(current));
      }, [])
      .map((f) => normalize(resolve(f)))
      .map((f) => {
        this.Log.trace({ file: f }, 'Found js localisation file at ${file}');
        return f;
      });

    for (const f of files) {
      const lang = basename(basename(f, '.js'), '.cjs');
      let data;

      try {
        data = await DI.__spinajs_require__(f);
      } catch (ex) {
        this.Log.warn({ error: ex, file: f, lang }, 'Cannot load localisation data from file ${file} for lang ${lang}');
        continue;
      }

      if (!data) {
        this.Log.warn({ file: f, lang }, 'No localisation data at ${file} for lang ${lang}');
        continue;
      }

      translations = _.merge({ [lang]: (data as any)[lang] ?? data }, translations);
    }

    return translations;
  }
}
