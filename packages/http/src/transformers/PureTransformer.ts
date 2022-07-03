import { DataTransformer } from '../interfaces';
import { Injectable, Singleton } from '@spinajs/di';
import * as express from 'express';

/**
 * Default transformer that does nothing. Output data is exacly same as input.
 */
@Singleton()
@Injectable(DataTransformer)
export class PureDataTransformer<T> extends DataTransformer<T, T> {
  public get Type(): string {
    return 'pure';
  }

  public transform(data: T, _request: express.Request): T {
    return data;
  }
}
