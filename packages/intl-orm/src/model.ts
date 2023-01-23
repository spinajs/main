import { DI } from '@spinajs/di';
import { InsertBehaviour, ModelBase } from '@spinajs/orm';
import _ from 'lodash';
import { IntlResource } from './models/IntlResource.js';
import { Configuration } from '@spinajs/configuration';
import { guessLanguage } from '@spinajs/intl';
export class Translatable extends ModelBase {
  protected Language: string;

  /**
   * Reloads entity with proper translation
   *
   * @param lang - language to load
   */
  public async translate(lang?: string) {
    const selectedLang = guessLanguage(lang);

    const translations = await IntlResource.where({
      ResourceId: this.PrimaryKeyValue,
      Resource: this.constructor.name,
      Lang: selectedLang,
    });

    translations.forEach((rd) => {
      (this as any)[(rd as any).Column] = (rd as any).Value;
    });

    this.Language = selectedLang;
  }

  public setLanguage(lang: string) {
    this.Language = lang;
  }

  public async update(): Promise<void> {
    const selectedLang = guessLanguage(this.Language);
    const defaultLanguage = DI.get(Configuration).get<string>('intl.defaultLocale');
    if (!selectedLang || defaultLanguage === selectedLang) {
      await super.update();
    } else {
      this.Language = selectedLang;
      // TODO: temporaty use uniqyBy, pls FIX model descriptor proper handling in ORM module
      const tColumns = _.uniqBy(
        this.ModelDescriptor.Columns.filter((c) => c.Translate),
        'Name',
      );

      const { query } = this.createUpdateQuery();

      if (this.ModelDescriptor.Timestamps.UpdatedAt) {
        (this as any)[this.ModelDescriptor.Timestamps.UpdatedAt] = new Date();
      }

      // update only non translated
      const cToDehydrate = [...tColumns.map((c) => c.Name)];
      const dToUpdate = _.omit(this.toSql(), cToDehydrate);

      if (Object.keys(dToUpdate).length !== 0) {
        await query.update(dToUpdate).where(this.PrimaryKeyName, this.PrimaryKeyValue);
      }

      const translations = tColumns.map((c) => {
        return new IntlResource({
          ResourceId: this.PrimaryKeyValue,
          Resource: this.constructor.name,
          Column: c.Name,
          Lang: this.Language,
          Value: (this as any)[c.Name],
        });
      });

      // update or insert translations to database
      for (const t of translations) {
        await t.insert(InsertBehaviour.InsertOrUpdate);
      }
    }
  }
}
