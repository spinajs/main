import { DatetimeValueConverter, extractDecoratorPropertyDescriptor } from '@spinajs/orm';

// @DateTime() refuses a `DateTime | null` property: the union's design type is Object.
export const NullableDateTime = (): PropertyDecorator =>
  extractDecoratorPropertyDescriptor((model, _target, key) => {
    model.Converters.set(key, { Class: DatetimeValueConverter });
  });
