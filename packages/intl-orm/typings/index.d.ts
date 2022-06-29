import { ISelectBuilderExtensions } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ISelectBuilderExtensions<T = any> {
    translate(lang: string): this;
  }
}
