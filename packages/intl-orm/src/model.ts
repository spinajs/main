import { InsertBehaviour, ModelBase } from '@spinajs/orm';
import _ from 'lodash';
import { IntlResource } from './models/IntlResource';

export class IntlModelBase extends ModelBase {
  public Language: string;

  /**
   * Reloads entity with proper translation
   *
   * @param lang - language to load
   */
  public async translate(lang: string) {
    const translations = await IntlResource.where({
      ResourceId: this.PrimaryKeyValue,
      Resource: this.constructor.name,
      Lang: lang,
    });

    translations.forEach((rd) => {
      (this as any)[(rd as any).Column] = (rd as any).Value;
    });

    this.Language = lang;
  }

  public async update(): Promise<void> {
    if (!this.Language) {
      await super.update();
    } else {
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
      const cToDehydrate = [this.PrimaryKeyName, ...tColumns.map((c) => c.Name)];
      const dToUpdate = this.dehydrate(cToDehydrate);

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
