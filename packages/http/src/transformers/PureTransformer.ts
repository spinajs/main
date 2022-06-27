import { DataTransformer } from '../interfaces';
import { Singleton } from '@spinajs/di';
import * as express from 'express';

/**
 * Default transformer that does nothing. Output data is exacly same as input.
 */
@Singleton()
export class PureDataTransformer<T> extends DataTransformer<T, T> {
  public get Type(): string {
    return 'pure';
  }

  public transform(data: T, _request: express.Request): T {
    return data;
  }
}
