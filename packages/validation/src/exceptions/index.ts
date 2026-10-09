import { Exception } from '@spinajs/exceptions';
import { ErrorObject } from 'ajv';

/**
 * Detailed information about a validation error
 */
export interface IValidationErrorDetail {
  /**
   * The field path that failed validation (e.g., "/user/email")
   */
  field: string;
  
  /**
   * The validation rule that failed (e.g., "required", "minLength", "pattern")
   */
  rule: string;
  
  /**
   * Human-readable description of why the validation failed
   */
  message: string;
  
  /**
   * Additional parameters related to the validation rule
   */
  params?: Record<string, any>;
}

/**
 * The exception that is thrown when JSON entity is checked against schema and is invalid
 *
 * It never holds a value of the validated data: details report the path, the rule, the message and the
 * rule params, so a 400 built from it cannot echo a password or a token back.
 *
 * @example
 * ```typescript
 * try {
 *   validator.validate(schema, data);
 * } catch (err) {
 *   if (err instanceof ValidationFailed) {
 *     // Access detailed error information
 *     console.log(err.details);
 *     // [{ field: '/email', rule: 'format', message: '/email must be a valid email', params: { format: 'email' } }]
 *     
 *     // Get human-readable summary
 *     console.log(err.getSummary());
 *     // "/email: /email must be a valid email; /age: /age must be at least 18"
 *     
 *     // Get errors for specific field
 *     const emailErrors = err.getFieldErrors('/email');
 *     
 *     // Access the expected schema (server side only: it is not serialised)
 *     console.log(err.schema);
 *     
 *     // Get requirements for a specific field
 *     const emailRequirements = err.getFieldRequirements('email');
 *   }
 * }
 * ```
 */
export class ValidationFailed extends Exception {
  /**
   * The AJV errors, reduced to `instancePath`, `schemaPath`, `keyword`, `params`, `message` and `propertyName`
   */
  public parameter: IValidationError[];

  /**
   * The schema that was used for validation. Not enumerable, so neither a spread nor JSON carries it.
   */
  public declare schema: any;

  /**
   * Detailed information about each validation failure
   */
  public details: IValidationErrorDetail[];

  constructor(message: string, validationErrors: IValidationError[], schema?: any) {
    super(message);
    Object.defineProperty(this, 'schema', { value: schema, writable: true, configurable: true, enumerable: false });
    this.parameter = validationErrors.map((error) => sanitizeError(error, schema));
    this.details = this.parameter.map((error) => ({
      field: error.instancePath || '(root)',
      rule: error.keyword,
      message: this.buildErrorMessage(error),
      params: error.params,
    }));
  }

  /**
   * Builds a human-readable error message from an AJV error
   */
  private buildErrorMessage(error: IValidationError): string {
    const field = error.instancePath || 'root';
    const params = error.params;

    if(error.message){ 
      return error.message;
    }

    switch (error.keyword) {
      case 'required':
        return `Field '${params.missingProperty}' is required`;
      case 'type':
        return `${field} must be of type ${params.type}`;
      case 'minLength':
        return `${field} must be at least ${params.limit} characters long`;
      case 'maxLength':
        return `${field} must not exceed ${params.limit} characters`;
      case 'minimum':
        return `${field} must be at least ${params.limit}`;
      case 'maximum':
        return `${field} must not exceed ${params.limit}`;
      case 'pattern':
        return `${field} does not match the required pattern`;
      case 'format':
        return `${field} must be a valid ${params.format}`;
      case 'enum':
        return `${field} must be one of: ${params.allowedValues?.join(', ')}`;
      case 'additionalProperties':
        return `${field} has additional property '${params.additionalProperty}' which is not allowed`;
      default:
        return error.message || `${field} failed validation rule '${error.keyword}'`;
    }
  }

  toString(): string {
    const detailedErrors = this.details
      .map((detail) => {
        const parts = [
          `  - Field: ${detail.field}`,
          `    Rule: ${detail.rule}`,
          `    Message: ${detail.message}`,
        ];
        
        if (detail.params && Object.keys(detail.params).length > 0) {
          parts.push(`    Params: ${JSON.stringify(detail.params)}`);
        }
        
        return parts.join('\n');
      })
      .join('\n\n');

    let result = `${this.message}\n\nValidation errors:\n${detailedErrors}`;
    
    // Only `$id`: an old 3-argument JavaScript caller passes the request data where the schema goes, and its
    // `title` or `description` fields would end up here.
    if (this.schema) {
      result += `\n\nExpected schema: ${(this.schema as any).$id || 'inline schema'}`;
    }
    
    return result;
  }

  /**
   * Returns a summary of all validation errors
   */
  public getSummary(): string {
    return this.details.map(d => `${d.field}: ${d.message}`).join('; ');
  }

  /**
   * Gets all validation errors for a specific field
   */
  public getFieldErrors(field: string): IValidationErrorDetail[] {
    return this.details.filter(d => d.field === field || d.field.startsWith(field + '/'));
  }

  /**
   * Gets the expected schema used for validation
   */
  public getExpectedSchema(): any {
    return this.schema;
  }

  /**
   * Gets a simplified view of schema requirements for a specific field
   */
  public getFieldRequirements(field: string): any {
    if (!this.schema || !(this.schema as any).properties) {
      return null;
    }

    const path = field.split('/').filter(p => p.length > 0);
    let schemaNode = this.schema;

    for (const segment of path) {
      if (schemaNode && (schemaNode as any).properties && (schemaNode as any).properties[segment]) {
        schemaNode = (schemaNode as any).properties[segment];
      } else {
        return null;
      }
    }

    return schemaNode;
  }
}

/* eslint-disable */
export interface IValidationError extends ErrorObject {}
/* eslint-enable */

// Keywords whose params and message carry the rule's value, which a `$data` rule takes from the request.
const VALUE_BEARING_KEYWORDS = new Set([
  'const',
  'enum',
  'pattern',
  'format',
  'required',
  'multipleOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'formatMinimum',
  'formatMaximum',
  'formatExclusiveMinimum',
  'formatExclusiveMaximum',
]);

const sanitized = new WeakSet<IValidationError>();

/**
 * Reduces an AJV error to `instancePath`, `schemaPath`, `keyword`, `params`, `message` (and `propertyName`), so
 * no request value can travel with it:
 *
 * - drops verbose mode's `data`, `schema` and `parentSchema`;
 * - for a rule written as `{ $data: pointer }`, whose params and message AJV builds from another field of the
 *   request (a password confirmation `const`, a `maxLength` read from a field), replaces params with
 *   `{ $data: pointer }` and the message with one naming only the keyword and the pointer;
 * - drops the `discriminator` `tagValue`, which is the request's tag value.
 *
 * The rule is found through the verbose `parentSchema` when present. Otherwise `schema`, when given, is searched
 * along the error's local `schemaPath`; when that path leads elsewhere and the schema uses `$data` anywhere, the
 * params and message of the value-bearing keywords are dropped.
 */
export function sanitizeError(error: IValidationError, schema?: unknown): IValidationError {
  if (sanitized.has(error)) {
    return error;
  }

  const clean: IValidationError = {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    params: error.params,
  };

  if (error.message !== undefined) {
    clean.message = error.message;
  }

  if (error.propertyName !== undefined) {
    clean.propertyName = error.propertyName;
  }

  const rule = error.parentSchema ? error.parentSchema[error.keyword] : schemaNodeAt(schema, error.schemaPath);

  if (isDataRef(rule)) {
    clean.params = { $data: rule.$data };
    clean.message = `must pass "${error.keyword}" against the value at $data "${rule.$data}"`;
  } else if (rule === undefined && !error.parentSchema && VALUE_BEARING_KEYWORDS.has(error.keyword) && usesData(schema)) {
    clean.params = {};
    clean.message = `must pass "${error.keyword}" keyword validation`;
  } else if (error.keyword === 'discriminator' && clean.params && 'tagValue' in clean.params) {
    clean.params = { ...clean.params };
    delete clean.params.tagValue;
  }

  sanitized.add(clean);
  return clean;
}

function isDataRef(node: unknown): node is { $data: string } {
  return typeof node === 'object' && node !== null && typeof (node as { $data?: unknown }).$data === 'string';
}

// `undefined` when the path is not local to `schema` (a `$ref` into another schema) or leads nowhere.
function schemaNodeAt(schema: unknown, schemaPath: string): unknown {
  if (!schema || typeof schemaPath !== 'string' || !schemaPath.startsWith('#/')) {
    return undefined;
  }

  let node: any = schema;
  for (const segment of schemaPath.slice(2).split('/')) {
    const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) {
      return undefined;
    }
    node = node[key];
  }

  return node;
}

function usesData(schema: unknown, seen = new Set<unknown>()): boolean {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) {
    return false;
  }
  seen.add(schema);

  return isDataRef(schema) || Object.values(schema).some((v) => usesData(v, seen));
}
