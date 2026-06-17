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
    const model = this.Models.get(typeName);
    if (!model) {
      return undefined;
    }

    /**
     * Use build in static method attached to all models
     * to get proper descriptor from prototype chain
     */
    const descriptor = (model as any).getModelDescriptor() as IModelDescriptor | undefined;
    const columns = descriptor?.Schema;
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
    if (columns.required && columns.required.length > 0) {
      schema.required = columns.required;
    }
    return schema;
  }
}
