import { DI } from '@spinajs/di';
import { InsertBehaviour, ModelBase, wherePk } from '@spinajs/orm';
import _ from 'lodash';
import { IntlResource } from './models/IntlResource.js';
import { Configuration } from '@spinajs/configuration-common';
import { guessLanguage } from '@spinajs/intl';
import { DateTime } from 'luxon';
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

  public async update(data?: Partial<this>) {
    const selectedLang = guessLanguage(this.Language);
    const defaultLanguage = DI.get(Configuration)!.get<string>('intl.defaultLocale');

    if (!selectedLang || defaultLanguage === selectedLang) {
      return await super.update(data);
    }

    let result = {
      RowsAffected: 0,
      LastInsertId: 0,
    };

    if (data) {
      this.hydrate(data);
    }

    this.Language = selectedLang;

    const keyColumns = this.ModelDescriptor!.PrimaryKey ?? [];
    const changed = this.changeSet()
      .map((c) => c.Column)
      .filter((c) => !keyColumns.includes(c));

    if (changed.length === 0) {
      return result;
    }

    // TODO: temporaty use uniqyBy, pls FIX model descriptor proper handling in ORM module
    const tColumns = _.uniqBy(
      this.ModelDescriptor!.Columns.filter((c) => c.Translate && changed.includes(c.Name)),
      'Name',
    );
    const tColumnNames = tColumns.map((c) => c.Name);
    const columnsToUpdate = changed.filter((c) => !tColumnNames.includes(c));

    const updatedAt = this.ModelDescriptor!.Timestamps.UpdatedAt;
    if (updatedAt) {
      (this as any)[updatedAt] = DateTime.now();
      if (!columnsToUpdate.includes(updatedAt)) {
        columnsToUpdate.push(updatedAt);
      }
    }

    if (columnsToUpdate.length !== 0) {
      const { query } = this.createUpdateQuery();
      const q = query.update(_.pick(this.toSql() as Record<string, unknown>, columnsToUpdate));
      wherePk(q, this.ModelDescriptor!, this.PrimaryKeyValue);
      result = await q;
    } else {
      // only translations changed: the entity is still saved, in intl_resources
      result = { RowsAffected: 1, LastInsertId: 0 };
    }

    for (const c of tColumns) {
      await new IntlResource({
        ResourceId: this.PrimaryKeyValue,
        Resource: this.constructor.name,
        Column: c.Name,
        Lang: this.Language,
        Value: (this as any)[c.Name],
      }).insert(InsertBehaviour.InsertOrUpdate);
    }

    this.takeSnapshot();

    return result;
  }
}
