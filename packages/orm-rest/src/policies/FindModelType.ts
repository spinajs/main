import { Autoinject, Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { BasePolicy, Request } from '@spinajs/http';
import { Orm } from '@spinajs/orm';

@Singleton()
export class FindModelType extends BasePolicy {
  @Autoinject()
  protected Orm: Orm;

  isEnabled(): boolean {
    return true;
  }
  execute(req: Request): Promise<void> {
    if (!req.query) {
      throw new InvalidOperation(`Invalid query parameters`);
    }

    if (!req.query.model) {
      throw new InvalidOperation(`Invalid query parameters, 'model' is required`);
    }

    const mClass = this.Orm.Models.find((x) => x.name === req.query.model);
    if (!mClass) {
      throw new InvalidOperation(`Resource type ${req.query.model} was not found`);
    }

    return Promise.resolve();
  }
}
