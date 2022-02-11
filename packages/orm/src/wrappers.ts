import { Wrap, DateTimeWrapper, DateWrapper } from './statements';

export const Wrapper = {
  Date: (val: any) => {
    return new Wrap(val, DateWrapper);
  },
  DateTime: (val: any) => {
    return new Wrap(val, DateTimeWrapper);
  },
};
