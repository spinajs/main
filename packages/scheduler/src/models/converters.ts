import { Injectable } from '@spinajs/di';
import { extractDecoratorPropertyDescriptor, IModelDescriptor, ValueConverter } from '@spinajs/orm';

// The ORM attaches a decorator's converter only when its class is registered in DI.
@Injectable()
export class EpochMsConverter extends ValueConverter {
  public toDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
  public fromDB(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
}

/** BIGINT epoch-ms column; normalizes the string Postgres returns for int8. */
export function EpochMs() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: EpochMsConverter });
  });
}

/** Static Model.update() binds by JS type, so JSON columns must be serialized by hand. */
export function jsonColumn(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
