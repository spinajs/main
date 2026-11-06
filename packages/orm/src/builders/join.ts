import { Container, NewInstance, isConstructor } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import _ from 'lodash';
import { JoinMethod } from '../enums.js';
import { RelationType } from '../interfaces.js';
import type { IWhereBuilder, IJoinBuilder, ISelectQueryBuilder, IJoinStatementOptions } from '../interfaces.js';
import { JoinStatement } from '../statements.js';
import type { IQueryStatement } from '../statements.js';
import type { ModelBase } from '../model.js';
import { extractModelDescriptor } from '../descriptor.js';
import { RawQuery } from './raw.js';

@NewInstance()
export class JoinBuilder implements IJoinBuilder {
  protected _model?: Constructor<ModelBase>;

  public get JoinStatements() {
    return this._joinStatements;
  }

  protected _joinStatements: IQueryStatement[] = [];
  protected _container: Container;
  protected _tableAlias: string;

  constructor(container: Container) {
    this._container = container;
    this._joinStatements = [];
  }

  public clearJoins(): this {
    this._joinStatements = [];

    return this;
  }


  public innerJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.INNER, arg1, arg2, arg3);
    return this;
  }

  public leftJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.LEFT, arg1, arg2, arg3);
    return this;
  }
  public leftOuterJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.LEFT_OUTER, arg1, arg2, arg3);
    return this;
  }
  public rightJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.RIGHT, arg1, arg2, arg3);
    return this;
  }
  public rightOuterJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.RIGHT_OUTER, arg1, arg2, arg3);
    return this;
  }
  public fullOuterJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.FULL_OUTER, arg1, arg2, arg3);
    return this;
  }
  public crossJoin<R = ModelBase>(arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {
    this.join<R>(JoinMethod.CROSS, arg1, arg2, arg3);
    return this;
  }

  public join<R = ModelBase>(method: JoinMethod, arg1: string | IJoinStatementOptions<R> | Constructor<R> | RawQuery, arg2?: (this: IWhereBuilder<R>) => void, arg3?: (this: ISelectQueryBuilder<R>) => void): this {

    let options: IJoinStatementOptions<R> | undefined;



    if (arg1 instanceof RawQuery) {
      options = {
        query: arg1
      }
    }
    else if (_.isString(arg1) || isConstructor(arg1)) {

      if (this._model === undefined) {
        throw new InvalidOperation(`Cannot use relation join without model defined in builder`);
      }

      const descriptor = extractModelDescriptor(this._model);
      const relations = descriptor?.Relations;

      if (!relations || relations.size === 0) {
        throw new InvalidOperation(`Model ${this._model.name} does not have any relations defined. Cannot use relation join.`);
      }

      const relation = this._model ? _.isString(arg1) ? relations.get(arg1) : relations.values().find((r) => r.TargetModel === (arg1 as Constructor<ModelBase>)) : null;
      if (!relation) {
        throw new InvalidArgument(`Cannot find relation ${arg1} in model ${this._model ? this._model.name : 'undefined'}`);
      }

      options = {
        joinModel: relation.TargetModel,

        joinTableForeignKey: relation.Type === RelationType.One ? relation.PrimaryKey : relation.ForeignKey,
        sourceTablePrimaryKey: relation.Type === RelationType.One ? relation.ForeignKey : relation.PrimaryKey,
        callback: arg2,
        queryCallback: arg3,
      };
    }
    else if (_.isObject(arg1)) {
      options = arg1;
    } else {
      throw new InvalidArgument(`Invalid argument passed to innerJoin: ${arg1}`);
    }

    const statement = this._container.resolve<JoinStatement>(JoinStatement, [{
      ...(options ?? {}),
      method,
      builder: this,
    }]);

    this.JoinStatements.push(
      statement
    )
    return this;
  }

}
