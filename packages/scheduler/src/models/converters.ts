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
 * JSON kept as text. Postgres and mysql2 hand JSON columns back already parsed, so a stored string
 * (`"ok"`) would come back as bare text that no longer reads as JSON, and `"123"` could not be told
 * from `123`. Text columns always return the JSON text, which parses back to exactly what was stored.
 */
@Injectable()
export class JsonTextConverter extends ValueConverter {
  public toDB(value: unknown): string | null {
    return jsonColumn(value);
  }
  /** Also runs on the input of `Model.create()`: a non-string value there is already the value. */
  public fromDB(value: unknown): unknown {
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value ?? null;
  }
}

export function JsonText() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: JsonTextConverter });
  });
}

/**
 * The text a `@JsonText()` column stores. Static `Model.update()` binds by JS type, and `Model.create()`
 * would parse a string value as JSON text, so a value of unknown shape is passed through this in both.
 */
export function jsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
