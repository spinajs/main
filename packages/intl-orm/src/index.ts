import { Container, DI, Inject, Injectable, NewInstance } from '@spinajs/di';
import { SelectQueryBuilder as SQB, extractModelDescriptor, IModelDescriptor, ModelBase, Orm, RelationType, SelectQueryBuilder, QueryBuilder, QueryMiddleware, IBuilderMiddleware, IOrmRelation, BelongsToRelation, ISelectQueryBuilder, NativeOrmRelation } from '@spinajs/orm';
import { TranslationSource, guessLanguage, defaultLanguage, IIntlAsyncStorage } from '@spinajs/intl';
import _ from 'lodash';
import { IntlTranslation } from './models/IntlTranslation.js';
import { IntlResource } from './models/IntlResource.js';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncLocalStorage } from 'async_hooks';

export * from './decorators.js';
export * from './migrations/IntlOrm_2022_06_28_01_13_00.js';
export * from './models/IntlResource.js';
export * from './models/IntlTranslation.js';
export * from './model.js';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /**
     *
     * Translates model to given language.
     * Working only with queries thata are model related ( created by model orm functions )
     * TODO: in future it should work with raw queries, by passing relation information for translation
     * TODO: fallback for translation from normal sources ( like config files )
     *
     * @param lang translate to language
     */
    translate(lang: string): SelectQueryBuilder<T>;
    translated: boolean;
    AllowTranslate: boolean;
  }
  interface IColumnDescriptor {
    Translate: boolean;
  }
}

@NewInstance()
@Inject(Container)
export class IntlModelRelation extends NativeOrmRelation {
  constructor(_container: Container, protected _lang: string, _query: ISelectQueryBuilder, protected _mDescriptor: IModelDescriptor, _parentRelation?: NativeOrmRelation) {
    super(
      _container,
      _query,
      {
        TargetModel: IntlResource as any,
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

  public compile(): void {
    this._query.middleware(new IntlModelMiddleware(this._lang, this._relationQuery, this._mDescriptor, this.parentRelation));
  }

  public translate(_lang: string) {
    // empty, cannot translate translation relation!
  }
}

export class IntlModelMiddleware implements IBuilderMiddleware {
  constructor(protected _lang: string, protected _relationQuery: ISelectQueryBuilder, protected _description: IModelDescriptor, protected _owner: IOrmRelation) {}

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
          let val = d as any;
          const relData = relationData.filter((rd) => {
            return (rd as any)['ResourceId'] === val[self._description.PrimaryKey];
          });

          relData.forEach((rd: IntlResource) => {
            if (self._owner && self._owner instanceof BelongsToRelation) {
              val[rd.Column] = rd.Value;
            } else {
              (d as any)[rd.Column] = rd.Value;
            }
          });

          val.setLanguage(self._lang);
        });
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn('ResourceId', pks);
      this._relationQuery.where('Resource', this._description.Name);
      this._relationQuery.where('Lang', this._lang);
      this._relationQuery.middleware(hydrateMiddleware);
      return (await this._relationQuery) as SelectQueryBuilder;
    }

    return [];
  }
}

(SQB.prototype as any)['translate'] = function (this: SelectQueryBuilder, lang: string) {
  /**
   * Cannot translate query that cames from translation middleware  !
   */
  if (this.Owner !== null && this.Owner instanceof IntlModelRelation) {
    return;
  }

  if (!this.Model) {
    return;
  }

  (this as any).translated = true;
  const descriptor = extractModelDescriptor(this._model);
  const relInstance = this._container.resolve(IntlModelRelation, [lang, this._container.get(Orm), this, descriptor, this._owner]);
  relInstance.execute();

  // translate all other relations automatically
  this._relations.forEach((r) => {
    r.executeOnQuery(function () {
      (this as any).translate(lang);
    });
  });

  this._relations.push(relInstance);
  return this;
};

/**
 * Middleware for automatic query translations
 * for modes. If query is standalone ( not created by model related function )
 * skips translation completely.
 * When AsyncStorage is set & language property is present
 *
 */
@Injectable(QueryMiddleware)
export class IntlQueryMiddleware extends QueryMiddleware {
  beforeQueryExecution(builder: QueryBuilder<any>): void {
    // if we dont have configuration module
    // we cannot guess default language
    // so skip trying to translate
    if (!DI.has(Configuration)) {
      return;
    }

    // if async storage is avaible ( node env)
    // on browser and electron skip this, as we dont have async storage
    if (typeof AsyncLocalStorage === 'function') {
      // if something has set to no translate
      // eg route decorator
      const store = DI.get<IIntlAsyncStorage>(AsyncLocalStorage);
      if (store && store.noTranslate === false) {
        return;
      }
    }

    // something has set to not translate manually for query
    if ((builder as any).AllowTranslate === false) {
      return;
    }

    // finaly, if its not query for model
    if (!builder.Model) {
      return;
    }

    // and translate only selects
    if (builder instanceof SQB && !(builder as any).translated) {
      const lang = guessLanguage();
      const dLang = defaultLanguage();

      // if we requested non-default language ?
      // if not we should translate
      if (lang && dLang !== lang) {
        (builder as any).translate(lang);
      }
    }
  }
  afterQueryCreation(_builder: QueryBuilder) {}
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
