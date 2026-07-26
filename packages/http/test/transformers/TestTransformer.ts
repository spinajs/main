import { DataTransformer } from '../../src/interfaces.js';
import { Singleton, Injectable } from '@spinajs/di';
import * as express from 'express';

/**
 * Test transformer registered as a DataTransformer (matching the framework's
 * built-in transformers). NOTE: the @Injectable(DataTransformer) decorator is
 * required here — with only @Singleton() the ts-node test transpiler drops the
 * `get Type()` accessor from the prototype, so Type resolves to undefined.
 */
@Singleton()
@Injectable(DataTransformer)
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
