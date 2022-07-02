import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IIntlAsyncStorage } from '@spinajs/intl';
import { AsyncLocalStorage } from 'node:async_hooks';

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
