import { DataTransformer } from '@spinajs/http';
import _ from 'lodash';
import { Injectable } from '@spinajs/di';
import * as express from 'express';

export interface IUserResult {
  Data: any;
  Total: number;
}

@Injectable()
export class UserDataTransformer<T> extends DataTransformer<IUserResult, IUserResult | T> {
  get Type(): string {
    return 'user-model-result';
  }

  public transform(data: IUserResult, _request: express.Request): IUserResult | T {
    if (_.isArray(data.Data)) {
      data.Data.forEach((x) => delete x.Password);
    } else {
      delete data.Data.Password;
    }

    return data;
  }
}
