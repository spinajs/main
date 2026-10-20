import { Injectable } from '@spinajs/di';
import { extractDecoratorPropertyDescriptor, IModelDescriptor, ValueConverter } from '@spinajs/orm';

/**
 * BIGINT column as a JS number; Postgres returns int8 as a string.
 * `@Injectable()` because the ORM attaches a decorator's converter only when its class is registered in DI.
 */
@Injectable()
export class Int8Converter extends ValueConverter {
  public toDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
  public fromDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
}

@Injectable()
export class EpochMsConverter extends Int8Converter {}

/** Postgres and mysql2 return DECIMAL as a string. */
@Injectable()
export class DecimalConverter extends Int8Converter {}

export function Int8() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: Int8Converter });
  });
}

export function Decimal() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: DecimalConverter });
  });
}

/** BIGINT epoch-ms column. */
export function EpochMs() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: EpochMsConverter });
  });
}

/**
 * The text to hand `Model.create()` for a `@Json()` column of unknown shape: create() reads a string
 * input as JSON text, so a JSON string value (`"ok"`) must arrive already serialized.
 * Static `Model.update()` serializes through the converter itself and takes the plain value.
 */
export function jsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
