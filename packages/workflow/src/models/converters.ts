import { Injectable } from '@spinajs/di';
import { extractDecoratorPropertyDescriptor, IModelDescriptor, ValueConverter } from '@spinajs/orm';

/**
 * BIGINT as a JS number; Postgres returns int8 as a string. The class name differs from the scheduler's
 * `Int8Converter` because DI caches converters by class name. `@Injectable()` because the ORM attaches a
 * decorator's converter only when its class is registered.
 */
@Injectable()
export class WorkflowInt8Converter extends ValueConverter {
  public toDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
  public fromDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
}

export function Int8(): PropertyDecorator {
  const decorator: PropertyDecorator = extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: WorkflowInt8Converter });
  });
  return decorator;
}

/**
 * The text to hand `Model.create()` for a `@Json()` column: create() reads a string input as JSON text, so a
 * JSON string value must arrive serialized. Static `Model.update()` serializes through the converter itself.
 */
export function jsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
