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
   * The actual value that failed validation (if available)
   */
  value?: any;
  
  /**
   * Additional parameters related to the validation rule
   */
  params?: Record<string, any>;
}

/**
 * The exception that is thrown when JSON entity is checked against schema and is invalid
 * 
 * @example
 * ```typescript
 * try {
 *   validator.validate(schema, data);
 * } catch (err) {
 *   if (err instanceof ValidationFailed) {
 *     // Access detailed error information
 *     console.log(err.details);
 *     // [{ field: '/email', rule: 'format', message: '/email must be a valid email', value: 'invalid-email' }]
 *     
 *     // Get human-readable summary
 *     console.log(err.getSummary());
 *     // "/email: /email must be a valid email; /age: /age must be at least 18"
 *     
 *     // Get errors for specific field
 *     const emailErrors = err.getFieldErrors('/email');
 *     
 *     // Access the data that failed
 *     console.log(err.data);
 *     
 *     // Access the expected schema
 *     console.log(err.schema);
 *     
 *     // Get requirements for a specific field
 *     const emailRequirements = err.getFieldRequirements('email');
 *   }
 * }
 * ```
 */
export class ValidationFailed extends Exception {
  public parameter: IValidationError[];
  
  /**
   * The data that failed validation
   */
  public data: any;
  
  /**
   * The schema that was used for validation
   */
  public schema: any;
  
  /**
   * Detailed information about each validation failure
   */
  public details: IValidationErrorDetail[];

  constructor(message: string, validationErrors: IValidationError[], data?: any, schema?: any) {
    super(message);
    this.parameter = validationErrors;
    this.data = data;
    this.schema = schema;
    this.details = this.buildDetailedErrors(validationErrors, data);
  }

  /**
   * Builds detailed error information from AJV validation errors
   */
  private buildDetailedErrors(errors: IValidationError[], data: any): IValidationErrorDetail[] {
    return errors.map((error) => {
      const detail: IValidationErrorDetail = {
        field: error.instancePath || '(root)',
        rule: error.keyword,
        message: this.buildErrorMessage(error),
        params: error.params,
      };

      // Try to extract the actual value that failed validation
      if (data && error.instancePath) {
        try {
          const path = error.instancePath.split('/').filter(p => p.length > 0);
          let value = data;
          for (const segment of path) {
            value = value?.[segment];
          }
          detail.value = value;
        } catch {
          // If we can't extract the value, just skip it
        }
      }

      return detail;
    });
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
        
        if (detail.value !== undefined) {
          parts.push(`    Value: ${JSON.stringify(detail.value)}`);
        }
        
        if (detail.params && Object.keys(detail.params).length > 0) {
          parts.push(`    Params: ${JSON.stringify(detail.params)}`);
        }
        
        return parts.join('\n');
      })
      .join('\n\n');

    let result = `${this.message}\n\nValidation errors:\n${detailedErrors}`;
    
    // Optionally include schema information if available
    if (this.schema) {
      const schemaId = (this.schema as any).$id || (this.schema as any).title || 'inline schema';
      result += `\n\nExpected schema: ${schemaId}`;
      
      // Include schema description if available
      if ((this.schema as any).description) {
        result += `\nDescription: ${(this.schema as any).description}`;
      }
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
