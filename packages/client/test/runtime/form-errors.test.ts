import 'mocha';
import { expect } from 'chai';
import { applyProblem, createClient, problemFieldErrors, ProblemError, type ProblemDetails } from '../../src/runtime/index.js';

// The body `@spinajs/http` answers for a `ValidationFailed`: the exception's own fields, `parameter` holding the Ajv errors.
const validationBody = {
  message: 'Validation failed',
  parameter: [
    { instancePath: '', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'name' }, message: "must have required property 'name'" },
    { instancePath: '/email', schemaPath: '#/properties/email/format', keyword: 'format', params: { format: 'email' }, message: 'must match format "email"' },
    { instancePath: '/email', schemaPath: '#/properties/email/maxLength', keyword: 'maxLength', params: { limit: 5 }, message: 'must NOT have more than 5 characters' },
    { instancePath: '/address/city', schemaPath: '#/properties/address/properties/city/minLength', keyword: 'minLength', params: { limit: 1 }, message: 'must NOT have fewer than 1 characters' },
    { instancePath: '/address', schemaPath: '#/properties/address/additionalProperties', keyword: 'additionalProperties', params: { additionalProperty: 'zip' }, message: 'must NOT have additional properties' },
    { instancePath: '/items/0/qty', schemaPath: '#/properties/items/items/properties/qty/minimum', keyword: 'minimum', params: { comparison: '>=', limit: 1 }, message: 'must be >= 1' },
    { instancePath: '/a~1b/c~0d', schemaPath: '#/x', keyword: 'type', params: { type: 'string' }, message: 'must be string' },
  ],
  details: [{ field: '/email', rule: 'format', message: 'must match format "email"', params: { format: 'email' } }],
};

const problem = (errors: unknown): ProblemDetails => ({ type: 'about:blank', title: 'Bad Request', status: 400, errors });
const problemError = (errors: unknown) => new ProblemError(problem(errors), 400);

type Call = [string, { type: string; message?: string }];
const collector = () => {
  const calls: Call[] = [];
  return { calls, setError: (name: string, error: { type: string; message?: string }) => void calls.push([name, error]) };
};

describe('problemFieldErrors', () => {
  it('maps instance paths to dotted field names and groups the errors of one field', () => {
    expect(problemFieldErrors(problem(validationBody.parameter))).to.deep.equal({
      name: [{ keyword: 'required', message: "must have required property 'name'" }],
      email: [
        { keyword: 'format', message: 'must match format "email"' },
        { keyword: 'maxLength', message: 'must NOT have more than 5 characters' },
      ],
      'address.city': [{ keyword: 'minLength', message: 'must NOT have fewer than 1 characters' }],
      'address.zip': [{ keyword: 'additionalProperties', message: 'must NOT have additional properties' }],
      'items.0.qty': [{ keyword: 'minimum', message: 'must be >= 1' }],
      'a/b.c~d': [{ keyword: 'type', message: 'must be string' }],
    });
  });

  it('puts a root error without a property under "root"', () => {
    const errors = [{ instancePath: '', keyword: 'anyOf', message: 'must match a schema in anyOf' }];
    expect(problemFieldErrors(problem(errors))).to.deep.equal({ root: [{ keyword: 'anyOf', message: 'must match a schema in anyOf' }] });
  });

  it('ignores items it does not understand, and a problem without a list', () => {
    expect(problemFieldErrors(problem([null, 'x', { keyword: 'type' }, { instancePath: '/a', keyword: 7 }, { instancePath: '/b', keyword: 'type' }]))).to.deep.equal({ b: [{ keyword: 'type' }] });
    expect(problemFieldErrors(problem(undefined))).to.deep.equal({});
    expect(problemFieldErrors(problem({ not: 'a list' }))).to.deep.equal({});
  });
});

describe('applyProblem', () => {
  it('sets the first error of each field and reports that it did', () => {
    const { calls, setError } = collector();
    expect(applyProblem(problemError(validationBody.parameter), setError)).to.equal(true);
    expect(calls.map(([name]) => name)).to.deep.equal(['name', 'email', 'address.city', 'address.zip', 'items.0.qty', 'a/b.c~d']);
    expect(calls[1]).to.deep.equal(['email', { type: 'format', message: 'must match format "email"' }]);
  });

  it('returns false and sets nothing for an error it cannot map', () => {
    for (const error of [new Error('boom'), null, undefined, 'x', problemError(undefined), problemError([]), new ProblemError({ type: 'about:blank', title: 'Not Found', status: 404 }, 404)]) {
      const { calls, setError } = collector();
      expect(applyProblem(error, setError), String(error)).to.equal(false);
      expect(calls).to.deep.equal([]);
    }
  });

  it('accepts a ProblemError from another copy of the package', () => {
    const { calls, setError } = collector();
    expect(applyProblem({ name: 'ProblemError', problem: problem(validationBody.parameter), status: 400 }, setError)).to.equal(true);
    expect(calls).to.have.length(6);
  });

  it('maps the body a real client call receives for a failed validation', async () => {
    const client = createClient<{ users: { create(body: unknown): Promise<unknown> } }>(
      { users: { create: { method: 'post', path: '/users', body: 'json' } } },
      { baseUrl: 'http://h', fetch: (() => Promise.resolve(Response.json(validationBody, { status: 400 }))) as typeof fetch },
    );
    const error: unknown = await client.users.create({}).catch((e: unknown) => e);
    const { calls, setError } = collector();
    expect(applyProblem(error, setError)).to.equal(true);
    expect(calls.map(([name]) => name)).to.include.members(['name', 'email', 'address.city']);
  });

  it('prefers the problem+json errors member over parameter', async () => {
    const body = { type: 'about:blank', title: 'Bad Request', status: 400, errors: [{ instancePath: '/x', keyword: 'type', message: 'must be string' }], parameter: [{ instancePath: '/y', keyword: 'type' }] };
    const client = createClient<{ users: { create(body: unknown): Promise<unknown> } }>(
      { users: { create: { method: 'post', path: '/users', body: 'json' } } },
      { baseUrl: 'http://h', fetch: (() => Promise.resolve(Response.json(body, { status: 400, headers: { 'content-type': 'application/problem+json' } }))) as typeof fetch },
    );
    const error: unknown = await client.users.create({}).catch((e: unknown) => e);
    const { calls, setError } = collector();
    applyProblem(error, setError);
    expect(calls.map(([name]) => name)).to.deep.equal(['x']);
  });
});
