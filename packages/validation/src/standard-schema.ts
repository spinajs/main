import type { IValidationError } from './exceptions/index.js';

/** Structural copy of the Standard Schema v1 interface (standardschema.dev), so no schema library is a dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const marker = (value as { '~standard'?: { validate?: unknown } })['~standard'];
  return typeof marker === 'object' && marker !== null && typeof marker.validate === 'function';
}

const pointerSegment = (segment: PropertyKey | { key: PropertyKey }): string => {
  const key = typeof segment === 'object' ? segment.key : segment;
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
};

/** Issues in the shape of an Ajv error, so `ValidationFailed` and the problem+json bodies built from it do not change. */
export function toValidationErrors(issues: readonly StandardIssue[]): IValidationError[] {
  return issues.map(
    (issue) =>
      ({
        keyword: 'standardSchema',
        instancePath: (issue.path ?? []).map((segment) => `/${pointerSegment(segment)}`).join(''),
        schemaPath: '#',
        params: {},
        message: issue.message,
      }),
  );
}
