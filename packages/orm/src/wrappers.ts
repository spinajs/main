import { Wrap, DateTimeWrapper, DateWrapper } from './statements.js';

export const Wrapper = {
  Date: (val: any) => {
    return new Wrap(val, DateWrapper);
  },
  DateTime: (val: any) => {
    return new Wrap(val, DateTimeWrapper);
  },
};
