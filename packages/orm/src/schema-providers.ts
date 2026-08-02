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
   * Ten sam zestaw kolumn co `getSchema`, ale BEZ `required`, bez kolumn z `_hidden` i z
   * typami, ktore naprawde wracaja z tego sterownika (`descriptor.ResponseSchema`).
   *
   * Odpowiedz jest z natury czesciowa: `dehydrateWithRelations({ skipUndefined: true })`
   * wyrzuca pola, ktorych zapytanie nie zaciagnelo, a `include` decyduje ktore relacje w
   * ogole sie pojawia. Lista wymaganych kolumn opisuje INSERT, nie to co leci do klienta -
   * wystawiona w odpowiedzi wywala walidacje na pierwszym wierszu bez np. hasla czy relacji.
   *
   * @param typeName - nazwa klasy modelu
   */
  public getResponseSchema(typeName: string): Record<string, unknown> | undefined {
    return this.buildSchema(typeName, false);
  }

  /**
   * Kolumny modelu + relacje jako wlasciwosci. `includeRequired` rozroznia kontrakt
   * zapisu (getSchema) od odczytu (getResponseSchema).
   *
   * @param typeName - nazwa klasy modelu
   * @param includeRequired - czy dolaczyc liste kolumn wymaganych (kontrakt zapisu)
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
   * Schemat odczytu z deskryptora. Buduje go `Orm.reloadTableInfo` razem z `Schema`; gdy go
   * nie ma (model nigdy nie dostal polaczenia, albo deskryptor zlozony recznie w tescie),
   * schodzimy na `Schema` i usuwamy z niego to, czego odpowiedz i tak nigdy nie niesie -
   * kolumny z `_hidden`. Lepiej opisac odczyt kontraktem zapisu niz nie opisac go wcale.
   *
   * @param descriptor - deskryptor modelu
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
