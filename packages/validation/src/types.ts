export interface ISchema {
  schema: ISchemaObject;
  file?: string;
}

export interface ISchemaObject {
  $id: string;
  [key: string]: any;
}

export abstract class SchemaSource {
  public abstract Load(): ISchema[];
}

export interface IValidationOptions {
  // enable all errors on  validation, not only first one that occurred
  allErrors: boolean;

  // remove properties that are not defined in schema
  removeAdditional: boolean;

  // set default values if possible
  useDefaults: boolean;

  // The option coerceTypes allows you to have your data types coerced to the types specified in your schema type keywords
  coerceTypes: boolean;
}
