import { NewInstance } from '@spinajs/di';
import { extractDecoratorDescriptor, extractModelDescriptor, IBuilderMiddleware, IModelDescrtiptor, InsertBehaviour, ModelBase, Orm, OrmRelation, RelationType, SelectQueryBuilder } from '@spinajs/orm';
import _ from 'lodash';
import { IntlResource } from './models/IntlResource';

declare module '@spinajs/orm' {
  interface ISelectBuilderExtensions<T = any> {
    translate(lang: string): this;
  }

  interface IColumnDescriptor {
    Translate: boolean;
  }
}

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

export function Translate() {
  return extractDecoratorDescriptor((model: IModelDescrtiptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Translate: true } as any);
    } else {
      columnDesc.Translate = true;
    }
  }, true);
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

          (d as IntlModelBase).Language = this._lang;
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

// @Injectable(Bootstrapper)
// export class IntlOrm extends Bootstrapper {
//   public bootstrap(): void {
//     DI.register(IntlBelongsToRelation).as(BelongsToRelation);
//     DI.register(IntlBelongsToRecursiveRelation).as(BelongsToRecursiveRelation);
//     DI.register(IntlOneToManyRelation).as(OneToManyRelation);
//     DI.register(IntlManyToManyRelation).as(ManyToManyRelation);
//   }
// }
