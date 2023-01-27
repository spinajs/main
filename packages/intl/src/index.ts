import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, AsyncService, Autoinject, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { InvalidArgument } from '@spinajs/exceptions';
import _ from 'lodash';
import * as util from 'util';
import * as MakePlural from 'make-plural';
import intervalParse from 'math-interval-parser';
import * as TranslatioSources from './sources.js';
export * from './sources.js';

const globalAny: any = global;

export interface IPhraseWithOptions {
  phrase: string;
  locale: string;
}

export interface IIntlAsyncStorage {
  language?: string;
}

export abstract class Intl extends AsyncService {
  private _currentLocale: string;

  /**
   * Currently selected locale
   */
  public get CurrentLocale() {
    return this._currentLocale;
  }

  /**
   * Currently selected locale
   */
  public set CurrentLocale(value: string) {
    if (!value) {
      throw new InvalidArgument('value cannot be empty or null');
    }

    this._currentLocale = value;
  }

  /**
   * Map with avaible translations, keyed by locale name
   */
  public Locales = {};

  /**
   * I18n localization function. Returns localized string.
   * If no translation is avaible at current selected language, then fallback to
   * default language, if still no translation exists, original text is returned
   *
   * @param text - text to localize.
   * @param args - argument passed to formatted text
   */
  public abstract __(text: string | IPhraseWithOptions, ...args: any[]): string;

  /**
   * Plurals translation of a single phrase. Singular and plural forms will get added to locales if unknown.
   * Returns translated parsed and substituted string based on last count parameter.
   *
   * @param text  - text to localize
   * @param count - number of items/things
   * @example use like `__n("%s cats", 1) returns `1 cat`
   */
  public abstract __n(text: string | IPhraseWithOptions, count: number): string;

  /**
   * Returns a list of translations for a given phrase in each language.
   *
   * @param text  - text to translate
   */
  public abstract __l(text: string): string[];

  /**
   * Returns a hashed list of translations for a given phrase in each language.
   *
   * @param text  - text to translate
   */
  public abstract __h(text: string): any[];
}

/**
 * Basic internationalization support. Text phrases are read from json files specified
 * in system.dirs.locales
 */
@Injectable(Intl)
export class SpineJsInternationalizationFromJson extends Intl {
  /**
   * Map with avaible translations, keyed by locale name
   */
  public Locales = {};

  /**
   * Logger for this module
   */
  @Logger('Intl')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  // tslint:disable-next-line: variable-name
  public async resolve() {
    this.CurrentLocale = this.Configuration.get('intl.defaultLocale', 'en');

    const sources = await DI.resolve(Array.ofType(TranslatioSources.TranslationSource));

    for (const s of sources) {
      const translations = await s.load();
      this.Locales = _.merge(translations, this.Locales);
    }
  }

  /**
   * I18n localization function. Returns localized string.
   * If no translation is avaible at current selected language, then fallback to
   * default language, if still no translation exists, original text is returned
   *
   * @param text  - text to localize.
   * @param args  - argument passed to formatted text
   */
  public __(text: string | IPhraseWithOptions, ...args: any[]): string {
    let locTable;
    let toLocalize;

    if (!text) return '';

    if (_.isString(text)) {
      locTable = (this.Locales as any)[this.CurrentLocale];
      toLocalize = text;
    } else {
      locTable = (this.Locales as any)[text.locale] ?? (this.Locales as any)[this.CurrentLocale];
      toLocalize = text.phrase;
    }

    if (!locTable) {
      return util.format(toLocalize, ...args);
    }

    return util.format(locTable[toLocalize] ?? toLocalize, ...args);
  }

  /**
   * Plurals translation of a single phrase.
   * Returns translated, parsed and substituted string based on count parameter.
   *
   * @param text  - text to localize
   * @param count - number of items/things
   * @example use like `__n("%s cats", 1) returns '1 cat'`
   */
  public __n(text: string | IPhraseWithOptions, count: number): string {
    let locTable;
    let toLocalize;
    let locale;

    if (!text) return '';

    if (_.isString(text)) {
      locale = this.CurrentLocale;
      locTable = (this.Locales as any)[this.CurrentLocale];
      toLocalize = text;
    } else {
      locale = text.locale ?? this.CurrentLocale;
      locTable = (this.Locales as any)[text.locale] ?? (this.Locales as any)[this.CurrentLocale];
      toLocalize = text.phrase;
    }

    if (/%/.test(toLocalize) && (this.Locales as any)[locale]) {
      const phrase = locTable[toLocalize];
      const pluralVerb = (MakePlural as any)[locale](count);

      if (phrase[pluralVerb]) {
        return util.format(phrase[pluralVerb], count);
      } else if (phrase.other) {
        return util.format(_getInterval(phrase.other, count), count);
      }

      return this.__(text, count);
    }

    return this.__(text, count);

    function _getInterval(text: string, count: number) {
      let toReturn = text;
      const phrases = text.split(/\|/);

      phrases.some((phrase) => {
        const matches = phrase.match(/^\s*([\(\)\[\]\d,]+)?\s*(.*)$/);

        if (matches[1] && _matchInterval(count, matches[1])) {
          toReturn = matches[2];
          return true;
        } else {
          toReturn = phrase;
        }
      });

      return toReturn;

      /**
       * test a number to match mathematical interval expressions
       * [0,2] - 0 to 2 (including, matches: 0, 1, 2)
       * ]0,3[ - 0 to 3 (excluding, matches: 1, 2)
       * [1]   - 1 (matches: 1)
       * [20,] - all numbers ≥20 (matches: 20, 21, 22, ...)
       * [,20] - all numbers ≤20 (matches: 20, 21, 22, ...)
       */
      function _matchInterval(c: number, eq: string) {
        const interval = intervalParse.default(eq);
        if (interval) {
          if (interval.from.value === c) {
            return interval.from.included;
          }

          if (interval.to.value === c) {
            return interval.from.included;
          }

          return Math.min(interval.from.value, c) === interval.from.value && Math.max(interval.to.value, c) === interval.to.value;
        }

        return false;
      }
    }
  }

  /**
   * Returns a list of translations for a given phrase in each language.
   *
   * @param text - text to translate
   */
  public __l(text: string): string[] {
    if (!text) return [];

    const extract = _.property(text);

    return Array.from(Object.values(this.Locales)).map((v) => {
      return extract(v) as string;
    });
  }

  /**
   * Returns a hashed list of translations for a given phrase in each language.
   *
   * @param text - text to translate
   */
  public __h(text: string): any[] {
    if (!text) return [];

    const extract = _.property(text);

    return Array.from(Object.values(this.Locales)).map((v, locale) => {
      return { [locale]: extract(v) };
    });
  }
}

/**
 * I18n localization function. Returns localized string.
 * If no translation is avaible at current selected language, then fallback to
 * default language, if still no translation exists, original text is returned
 *
 * @param text  - text to localize.
 * @param locale  - selected locale, if not specified - default locale is selected
 */
globalAny.__ = (text: string | IPhraseWithOptions, ...args: any[]) => {
  return DI.get<Intl>(Intl).__(text, ...args);
};

/**
 * Plurals translation of a single phrase. Singular and plural forms will get added to locales if unknown.
 * Returns translated parsed and substituted string based on last count parameter.
 *
 * @param text  - text to localize
 * @param count  - number of items/things
 * @example use like `__n("%s cats", 1) returns `1 cat`
 */
globalAny.__n = (text: string | IPhraseWithOptions, count: number) => {
  return DI.get<Intl>(Intl).__n(text, count);
};

/**
 * Returns a list of translations for a given phrase in each language.
 *
 * @param text  - text to translate
 */
globalAny.__l = (text: string) => {
  return DI.get<Intl>(Intl).__l(text);
};

/**
 * Returns a hashed list of translations for a given phrase in each language.
 *
 * @param text  - text to translate
 */
globalAny.__h = (text: string) => {
  return DI.get<Intl>(Intl).__h(text);
};

/**
 *  Helper function for translations ( eg. for use as in template rentering engines)
 */

export function __translate(lang: string) {
  return (text: string | IPhraseWithOptions, ...args: any[]) => {
    const intl = DI.get<Intl>(Intl);
    if (typeof text === 'string') {
      return intl.__(
        {
          phrase: text,
          locale: lang,
        },
        ...args,
      );
    }

    return intl.__(text, ...args);
  };
}

export function __translateNumber(lang: string) {
  return (text: string | IPhraseWithOptions, count: number) => {
    const intl = DI.get<Intl>(Intl);
    if (typeof text === 'string') {
      return intl.__n(
        {
          phrase: text,
          locale: lang,
        },
        count,
      );
    }

    return intl.__n(text, count);
  };
}

export function __translateL(text: string) {
  const intl = DI.get<Intl>(Intl);
  return intl.__l(text);
}
export function __translateH(text: string) {
  const intl = DI.get<Intl>(Intl);
  return intl.__h(text);
}

export function guessLanguage(lang?: string) {
  let selectedLang = lang;
  if (!selectedLang) {
    const store = DI.get(AsyncLocalStorage);
    if (store) {
      const storage = DI.get(AsyncLocalStorage).getStore() as IIntlAsyncStorage;
      if (!storage || !storage.language) {
        selectedLang = DI.get(Configuration).get<string>('intl.defaultLocale');
      } else {
        selectedLang = storage.language;
      }
    } else {
      selectedLang = DI.get(Configuration).get<string>('intl.defaultLocale');
    }
  }

  return selectedLang;
}

export function defaultLanguage() {
  return DI.get(Configuration).get<string>('intl.defaultLocale');
}
