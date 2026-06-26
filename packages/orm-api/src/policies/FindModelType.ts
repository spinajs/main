import { Orm } from '@spinajs/orm';
import { Autoinject, Singleton } from '@spinajs/di';
import { BasePolicy, Request as sRequest } from '@spinajs/http';
import { InvalidOperation } from '@spinajs/exceptions';


@Singleton()
export class FindModelType extends BasePolicy {
  @Autoinject()
  protected Orm: Orm;

  isEnabled(): boolean {
    return true;
  }
  execute(req: sRequest): Promise<void> {
    if (!req.params) {
      throw new InvalidOperation(`Invalid query parameters`);
    }

    if (!req.params.model) {
      throw new InvalidOperation(`Invalid query parameters, 'model' is required`);
    }

    const model = Array.isArray(req.params.model) ? req.params.model[0] : req.params.model;
    const mClass = this.Orm.Models.find((x) => x.name.toLowerCase() === model.trim().toLowerCase());
    if (!mClass) {
      throw new InvalidOperation(`Resource type ${req.params.model} was not found`);
    }

    return Promise.resolve();
  }
}
