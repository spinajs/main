import { Wrap, DateTimeWrapper, DateWrapper, TextWrapper } from './statements.js';

export const Wrapper = {
  Date: (val: any) => {
    return new Wrap(val, DateWrapper);
  },
  DateTime: (val: any) => {
    return new Wrap(val, DateTimeWrapper);
  },
  /** The column cast to the dialect's text type, to compare a column of any type with text. */
  Text: (column: string) => {
    return new Wrap(column, TextWrapper);
  },
};
