import { DataTransformer } from '../interfaces.js';
import { Injectable, Singleton } from '@spinajs/di';

/**
 * Default transformer that does nothing. Output data is exacly same as input.
 */
@Singleton()
@Injectable(DataTransformer)
export class DefaultErrorTransform extends DataTransformer {
  public get Type(): string {
    return 'default-http-error-transform';
  }

  public transform(data: { error?: Error; message?: string; stack?: string } | string) {
    return data;
  }
}
