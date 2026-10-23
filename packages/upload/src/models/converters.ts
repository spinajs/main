import { DatetimeValueConverter, extractDecoratorPropertyDescriptor } from '@spinajs/orm';

// @DT() refuses a `DateTime | null` property: the union's design type is Object (teams/src/models/converters.ts:3-8).
export const NullableDateTime = (): PropertyDecorator => {
  const decorator: PropertyDecorator = extractDecoratorPropertyDescriptor((model, _target, key) => {
    model.Converters.set(key, { Class: DatetimeValueConverter });
  });
  return decorator;
};
