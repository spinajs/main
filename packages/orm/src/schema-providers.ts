import { Class, DI, Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';
import { IModelDescriptor } from './interfaces.js';

const TO_MANY_RELATION = new Set<number>([1, 2]);

/**
 * Resolves an ORM model name to its column schema plus relations. A name → model
 * class map is built once at initialization (see `resolve`) and reused on every
 * lookup, so we don't rescan the `'__models__'` registry per call.
 */
@Injectable(SchemaProvider)
export class ModelSchemaProvider extends SchemaProvider {
  protected Models = new Map<string, Class<unknown>>();

  public resolve(): void {
    for (const model of DI.getRegisteredTypes('__models__')) {
      this.Models.set(model.name, model as Class<unknown>);
    }
  }

  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return this.buildSchema(typeName, true);
  }

  /**
   * The same set of columns as `getSchema`, but WITHOUT `required`, without the `@Hidden()`
   * columns, and with the types this driver really returns (`descriptor.ResponseSchema`).
   *
   * A response is partial by nature: `dehydrateWithRelations({ skipUndefined: true })` drops
   * fields the query did not load, and `include` decides which relations show up at all. The
   * list of required columns describes an INSERT, not what goes out to the client - published
   * on a response it breaks validation on the first row that has no password or no relation.
   *
   * @param typeName - the model class name
   */
  public getResponseSchema(typeName: string): Record<string, unknown> | undefined {
    return this.buildSchema(typeName, false);
  }

  /**
   * The model's columns plus its relations as properties. `includeRequired` distinguishes
   * the write contract (getSchema) from the read one (getResponseSchema).
   *
   * @param typeName - the model class name
   * @param includeRequired - whether to include the list of required columns (write contract)
   */
  protected buildSchema(typeName: string, includeRequired: boolean): Record<string, unknown> | undefined {
    const model = this.Models.get(typeName);
    if (!model) {
      return undefined;
    }

    /**
     * Use build in static method attached to all models
     * to get proper descriptor from prototype chain
     */
    const descriptor = (model as any).getModelDescriptor() as IModelDescriptor | undefined;
    const columns = includeRequired ? descriptor?.Schema : this.responseColumns(descriptor);
    if (!columns || !columns.properties) {
      return undefined;
    }

    const properties: Record<string, unknown> = { ...columns.properties };
    descriptor?.Relations?.forEach((relation, relationName) => {
      const target = relation?.TargetModel?.name;
      if (!target) {
        return;
      }
      const ref = { type: 'object', description: target };
      properties[relationName] =
        relation.Type !== undefined && TO_MANY_RELATION.has(relation.Type) ? { type: 'array', items: ref } : ref;
    });

    const schema: Record<string, unknown> = { type: 'object', properties };
    if (includeRequired && columns.required && columns.required.length > 0) {
      schema.required = columns.required;
    }
    return schema;
  }

  /**
   * The read schema off the descriptor. `Orm.reloadTableInfo` builds it alongside `Schema`;
   * when it is absent (the model never got a connection, or the descriptor was assembled by
   * hand in a test) we fall back to `Schema` and strip from it what a response never carries
   * anyway - the `@Hidden()` columns. Describing a read with the write contract beats not
   * describing it at all.
   *
   * @param descriptor - the model descriptor
   */
  protected responseColumns(descriptor: IModelDescriptor | undefined): { properties?: Record<string, unknown>; required?: string[] } | undefined {
    const response = descriptor?.ResponseSchema;
    if (response?.properties) {
      return response;
    }

    const write = descriptor?.Schema;
    if (!write?.properties) {
      return undefined;
    }

    const hidden = new Set(descriptor?.Hidden ?? []);
    if (hidden.size === 0) {
      return write;
    }

    const properties = Object.fromEntries(Object.entries(write.properties as Record<string, unknown>).filter(([name]) => !hidden.has(name)));
    return { properties };
  }
}
