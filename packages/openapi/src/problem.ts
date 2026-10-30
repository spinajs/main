/**
 * RFC 9457 body emitted by `@spinajs/http`, used when neither the manifest nor the options provide one.
 * Kept inline so the generator needs no runtime dependency on `@spinajs/http`; a test pins it to `PROBLEM_DETAILS_SCHEMA`.
 */
export const FALLBACK_PROBLEM_SCHEMA: Record<string, unknown> = {
  title: 'ProblemDetails',
  description: 'RFC 9457 problem details',
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', description: 'about:blank, or a URI identifying the problem type.' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    errors: { description: 'Validation errors, present on validation failures only.' },
    stack: { type: 'string', description: 'Present only when http.errors.includeStack is enabled outside production.' },
  },
  additionalProperties: true,
};
