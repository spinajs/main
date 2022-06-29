import { NewInstance } from '@spinajs/di';
import { extractDecoratorDescriptor, extractModelDescriptor, IBuilderMiddleware, IModelDescrtiptor, ModelBase, Orm, OrmRelation, SelectQueryBuilder } from '@spinajs/orm';
import _ from 'lodash';

export function Translate() {
  return extractDecoratorDescriptor((model: IModelDescrtiptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Translate: true } as any);
    } else {
      (columnDesc as any).Translate = true;
    }
  }, true);
}

@NewInstance()
export class IntlModelRelation extends OrmRelation {
  constructor(protected _lang: string, _orm: Orm, _query: SelectQueryBuilder<any>, protected _mDescriptor: IModelDescrtiptor, _parentRelation?: OrmRelation) {
    super(_orm, _query, null, _parentRelation);

    this._relationQuery.from('intl_resources', this.Alias);
  }

  public execute(): void {
    this._query.middleware(new IntlModelMiddleware(this._lang, this._relationQuery, this._mDescriptor));
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
  this._relations.push(relInstance);
  return this;
};
