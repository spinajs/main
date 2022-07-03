import { DataTransformer } from '../../src/interfaces';
import { Singleton } from '@spinajs/di';
import * as express from 'express';

/**
 * Default transformer that does nothing. Output data is exacly same as input.
 */
@Singleton()
export class TestTransformer<T> extends DataTransformer<T, any> {
  public get Type(): string {
    return 'test-transform';
  }

  public transform(_: T, _request: express.Request) {
    return {
      message: 'hello world transformed',
    };
  }
}
