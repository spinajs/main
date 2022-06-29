import { Injectable, NewInstance } from '@spinajs/di';
import { extractModelDescriptor, IBuilderMiddleware, IModelDescrtiptor, ModelBase, Orm, OrmRelation, RelationType, SelectQueryBuilder } from '@spinajs/orm';
import { TranslationSource } from '@spinajs/intl';
import _ from 'lodash';
import { IntlTranslation } from './models/IntlTranslation';
import { IntlResource } from './models/IntlResource';

declare module '@spinajs/orm' {
  interface ISelectBuilderExtensions<T = any> {
    translate(lang: string): this;
  }

  interface IColumnDescriptor {
    Translate: boolean;
  }
}

@NewInstance()
export class IntlModelRelation extends OrmRelation {
  constructor(protected _lang: string, _orm: Orm, _query: SelectQueryBuilder<any>, protected _mDescriptor: IModelDescrtiptor, _parentRelation?: OrmRelation) {
    super(
      _orm,
      _query,
      {
        TargetModel: IntlResource,
        Name: 'Translations',
        Type: RelationType.Many,
        SourceModel: null,
        ForeignKey: '',
        PrimaryKey: '',
        Recursive: false,
      },
      _parentRelation,
    );

    this._relationQuery.from('intl_resources', this.Alias);
  }

  public execute(): void {
    this._query.middleware(new IntlModelMiddleware(this._lang, this._relationQuery, this._mDescriptor));
  }

  public translate(_lang: string) {
    // empty, cannot translate translation relation!
  }
}

export class IntlModelMiddleware implements IBuilderMiddleware {
  constructor(protected _lang: string, protected _relationQuery: SelectQueryBuilder, protected _description: IModelDescrtiptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }
  public modelCreation(_: any): ModelBase {
    return null;
  }
  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => {
      return (d as any)[this._description.PrimaryKey];
    });

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        data.forEach((d) => {
          const relData = relationData.filter((rd) => {
            return (rd as any)['ResourceId'] === (d as any)[self._description.PrimaryKey];
          });

          relData.forEach((rd) => {
            (d as any)[(rd as any).Column] = (rd as any).Value;
          });

          (d as any).Language = this._lang;
        });
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn('ResourceId', pks);
      this._relationQuery.where('Resource', this._description.Name);
      this._relationQuery.where('Lang', this._lang);
      this._relationQuery.middleware(hydrateMiddleware);
      return await this._relationQuery;
    }

    return [];
  }
}

(SelectQueryBuilder.prototype as any)['translate'] = function (this: SelectQueryBuilder, lang: string) {
  const descriptor = extractModelDescriptor(this._model);
  const relInstance = this._container.resolve(IntlModelRelation, [lang, this._container.get(Orm), this, descriptor, this._owner]);
  relInstance.execute();

  // translate all other relations automatically
  this._relations.forEach((r) => {
    r.executeOnQuery(function () {
      this.translate(lang);
    });
  });

  this._relations.push(relInstance);
  return this;
};

@Injectable(TranslationSource)
export class DbTranslationSource extends TranslationSource {
  public async load() {
    const translations = await IntlTranslation.all();

    return _.mapValues(_.groupBy(translations, 'Lang'), (t) => {
      const vals = t.map((tt) => {
        return { [tt.Key]: tt.Value };
      });

      return _.assign.apply(_, vals);
    });
  }
}
