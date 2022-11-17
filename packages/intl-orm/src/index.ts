import { Injectable, NewInstance } from '@spinajs/di';
import { extractModelDescriptor, IModelDescriptor, ModelBase, Orm, OrmRelation, RelationType, SelectQueryBuilder, QueryBuilder, QueryMiddleware, IBuilderMiddleware, IOrmRelation, BelongsToRelation } from '@spinajs/orm';
import { TranslationSource, guessLanguage, defaultLanguage } from '@spinajs/intl';
import _ from 'lodash';
import { IntlTranslation } from './models/IntlTranslation';
import { IntlResource } from './models/IntlResource';

export * from './decorators';
export * from './model';
export * from './migrations/IntlOrm_2022_06_28_01_13_00';
export * from './models/IntlResource';
export * from './models/IntlTranslation';

declare module '@spinajs/orm' {
  interface ISelectBuilderExtensions<T = any> {
    translate(lang: string): this;
    translated: boolean;
  }

  interface IColumnDescriptor {
    Translate: boolean;
  }
}

@NewInstance()
export class IntlModelRelation extends OrmRelation {
  constructor(protected _lang: string, _orm: Orm, _query: SelectQueryBuilder<any>, protected _mDescriptor: IModelDescriptor, _parentRelation?: OrmRelation) {
    super(
      _orm,
      _query,
      {
        TargetModel: IntlResource,
        TargetModelType: IntlResource,
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
    this._query.middleware(new IntlModelMiddleware(this._lang, this._relationQuery, this._mDescriptor, this.parentRelation));
  }

  public translate(_lang: string) {
    // empty, cannot translate translation relation!
  }
}

export class IntlModelMiddleware implements IBuilderMiddleware {
  constructor(protected _lang: string, protected _relationQuery: SelectQueryBuilder, protected _description: IModelDescriptor, protected _owner: IOrmRelation) {}

  public afterQueryCreation(_query: QueryBuilder<any>): void {}

  public afterQuery(data: any[]): any[] {
    return data;
  }
  public modelCreation(_: any): ModelBase {
    return null;
  }
  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => {
      // do this as one pass
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
            if (self._owner && self._owner instanceof BelongsToRelation) {
              let val = d as any;
              let rel = self._owner as OrmRelation;

              let relArr = [];
              while (rel) {
                relArr.push(rel);
                rel = rel.parentRelation;
              }

              relArr = relArr.reverse();
              relArr.forEach((r) => {
                val = val[r.Name].Value;
              });

              val[(rd as any).Column] = (rd as any).Value;
              val.setLanguage(self._lang);
            } else {
              (d as any)[(rd as any).Column] = (rd as any).Value;
            }
          });

          (d as any).Language = self._lang;
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
  /**
   * Cannot translate query that cames from translation middleware  !
   */
  if (this.Owner !== null && this.Owner instanceof IntlModelRelation) {
    return;
  }

  this.translated = true;
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

@Injectable(QueryMiddleware)
export class IntlQueryMiddleware extends QueryMiddleware {
  afterQueryCreation(builder: QueryBuilder) {
    if (builder instanceof SelectQueryBuilder && !builder.translated) {
      const lang = guessLanguage();
      const dLang = defaultLanguage();

      if (lang && dLang !== lang) {
        builder.translate(lang);
      }
    }
  }
}

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
