import 'mocha';
import { expect } from 'chai';
import { applyProblem, createClient, problemFieldErrors, ProblemError, type ProblemDetails } from '../../src/runtime/index.js';
import { typecheckFiles } from '../support/typecheck.js';

// Bodies `@spinajs/http` answers (`application/problem+json`) for the manifest-validation fixture of its test suite.
// The server sends no `message`, and says which argument an error belongs to with `in` and `name`.
const head = (instance: string) => ({ type: 'about:blank', title: 'Validation Failed', status: 400, detail: 'validation error', instance });
const bodies = {
  wrongType: { ...head('/manifest-validation/create'), errors: [{ instancePath: '/count', schemaPath: '#/properties/count/type', keyword: 'type', params: { type: 'number' }, in: 'body' }] },
  missingRequired: { ...head('/manifest-validation/create'), errors: [{ instancePath: '', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'count' }, in: 'body' }] },
  arrayItem: { ...head('/manifest-validation/create'), errors: [{ instancePath: '/tags/0', schemaPath: '#/properties/tags/items/type', keyword: 'type', params: { type: 'string' }, in: 'body' }] },
  rootNotObject: { ...head('/manifest-validation/create'), errors: [{ instancePath: '', schemaPath: '#/type', keyword: 'type', params: { type: 'object' }, in: 'body' }] },
  pair: { ...head('/manifest-validation/pair'), errors: [{ instancePath: '/count', schemaPath: '#/properties/count/type', keyword: 'type', params: { type: 'number' }, in: 'body', name: 'second' }] },
  enumQuery: { ...head('/manifest-validation/sorted'), errors: [{ instancePath: '', schemaPath: '#/enum', keyword: 'enum', params: { allowedValues: ['asc', 'desc'] }, in: 'query', name: 'sort' }] },
  wholeQuery: { ...head('/manifest-validation/search'), errors: [{ instancePath: '/page', schemaPath: '#/properties/page/type', keyword: 'type', params: { type: 'number' }, in: 'query' }] },
};

const problem = (errors: unknown): ProblemDetails => ({ type: 'about:blank', title: 'Validation Failed', status: 400, errors });
const problemError = (errors: unknown) => new ProblemError(problem(errors), 400);

type Call = [string, { type: string; message?: string }];
const collector = () => {
  const calls: Call[] = [];
  return { calls, setError: (name: string, error: { type: string; message?: string }) => void calls.push([name, error]) };
};

const reply = (body: unknown): Promise<unknown> => {
  const client = createClient<{ users: { create(body: unknown): Promise<unknown> } }>(
    { users: { create: { method: 'post', path: '/users', body: 'json' } } },
    { baseUrl: 'http://h', fetch: (() => Promise.resolve(Response.json(body, { status: 400, headers: { 'content-type': 'application/problem+json' } }))) as typeof fetch },
  );
  return client.users.create({}).catch((e: unknown) => e);
};

const appliedTo = async (body: unknown, options?: Parameters<typeof applyProblem>[2]): Promise<Call[]> => {
  const { calls, setError } = collector();
  expect(applyProblem(await reply(body), setError, options)).to.equal(true);
  return calls;
};

describe('problemFieldErrors', () => {
  it('maps instance paths to dotted field names and groups the errors of one field', () => {
    const errors = [
      { instancePath: '/email', keyword: 'format', params: { format: 'email' } },
      { instancePath: '/email', keyword: 'maxLength', params: { limit: 5 } },
      { instancePath: '/address/city', keyword: 'minLength', params: { limit: 1 } },
      { instancePath: '/items/0/qty', keyword: 'minimum', params: { limit: 1 } },
    ];
    expect(problemFieldErrors(problem(errors))).to.deep.equal({
      email: [
        { keyword: 'format', message: 'must be a valid email' },
        { keyword: 'maxLength', message: 'must be at most 5 characters' },
      ],
      'address.city': [{ keyword: 'minLength', message: 'must be at least 1 characters' }],
      'items.0.qty': [{ keyword: 'minimum', message: 'must be at least 1' }],
    });
  });

  it('names a missing property under its parent', () => {
    const errors = [
      { instancePath: '', keyword: 'required', params: { missingProperty: 'name' } },
      { instancePath: '/address', keyword: 'required', params: { missingProperty: 'city' } },
    ];
    expect(Object.keys(problemFieldErrors(problem(errors)))).to.deep.equal(['name', 'address.city']);
  });

  it('sends an additionalProperties error to the parent field, or to root without one', () => {
    const errors = [
      { instancePath: '/address', keyword: 'additionalProperties', params: { additionalProperty: 'zip' } },
      { instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'extra' } },
    ];
    expect(problemFieldErrors(problem(errors))).to.deep.equal({
      address: [{ keyword: 'additionalProperties', message: 'is not allowed' }],
      root: [{ keyword: 'additionalProperties', message: 'is not allowed' }],
    });
  });

  it('undoes the JSON pointer escapes in the right order', () => {
    const names = ['/a~1b', '/c~0d', '/e~01f', '/g~10h'].map((instancePath) => ({ instancePath, keyword: 'type', params: { type: 'string' } }));
    expect(Object.keys(problemFieldErrors(problem(names)))).to.deep.equal(['a/b', 'c~d', 'e~1f', 'g/0h']);
  });

  it('prefixes the argument name, which the errors of that argument are relative to', () => {
    expect(Object.keys(problemFieldErrors(problem(bodies.pair.errors)))).to.deep.equal(['second.count']);
    expect(Object.keys(problemFieldErrors(problem(bodies.enumQuery.errors)))).to.deep.equal(['sort']);
    expect(Object.keys(problemFieldErrors(problem(bodies.wholeQuery.errors)))).to.deep.equal(['page']);
    expect(Object.keys(problemFieldErrors(problem(bodies.wrongType.errors)))).to.deep.equal(['count']);
  });

  it('puts an error on the whole body under "root"', () => {
    expect(problemFieldErrors(problem(bodies.rootNotObject.errors))).to.deep.equal({ root: [{ keyword: 'type', message: 'must be an object' }] });
  });

  it('ignores items it does not understand, and a problem without a list', () => {
    expect(problemFieldErrors(problem([null, 'x', { keyword: 'type' }, { instancePath: '/a', keyword: 7 }, { instancePath: '/b', keyword: 'nonsense' }]))).to.deep.equal({ b: [{ keyword: 'nonsense', message: 'is invalid' }] });
    expect(problemFieldErrors(problem(undefined))).to.deep.equal({});
    expect(problemFieldErrors(problem({ not: 'a list' }))).to.deep.equal({});
  });

  it('writes a plain English message from the keyword and its params', () => {
    const message = (keyword: string, params: Record<string, unknown>) => Object.values(problemFieldErrors(problem([{ instancePath: '/f', keyword, params }])))[0][0].message;
    expect(message('required', { missingProperty: 'f' })).to.equal('is required');
    expect(message('type', { type: 'number' })).to.equal('must be a number');
    expect(message('type', { type: 'integer' })).to.equal('must be an integer');
    expect(message('type', { type: ['string', 'null'] })).to.equal('must be a string or null');
    expect(message('enum', { allowedValues: ['asc', 'desc'] })).to.equal('must be one of: asc, desc');
    expect(message('pattern', { pattern: '^x' })).to.equal('has an invalid format');
    expect(message('exclusiveMinimum', { limit: 3 })).to.equal('must be greater than 3');
  });

  it('takes the text from the messages option, and keeps the default where it returns undefined', () => {
    const errors = [
      { instancePath: '', keyword: 'required', params: { missingProperty: 'a' } },
      { instancePath: '/b', keyword: 'type', params: { type: 'number' } },
    ];
    const messages = ({ keyword }: { keyword: string }) => (keyword === 'required' ? 'jest wymagane' : undefined);
    expect(problemFieldErrors(problem(errors), { messages })).to.deep.equal({ a: [{ keyword: 'required', message: 'jest wymagane' }], b: [{ keyword: 'type', message: 'must be a number' }] });
  });
});

describe('applyProblem', () => {
  it('sets the first error of each field and reports that it did', () => {
    const { calls, setError } = collector();
    const errors = [
      { instancePath: '/email', keyword: 'format', params: { format: 'email' } },
      { instancePath: '/email', keyword: 'maxLength', params: { limit: 5 } },
      { instancePath: '', keyword: 'required', params: { missingProperty: 'name' } },
    ];
    expect(applyProblem(problemError(errors), setError)).to.equal(true);
    expect(calls).to.deep.equal([
      ['email', { type: 'format', message: 'must be a valid email' }],
      ['name', { type: 'required', message: 'is required' }],
    ]);
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
    expect(applyProblem({ name: 'ProblemError', problem: problem(bodies.wrongType.errors), status: 400 }, setError)).to.equal(true);
    expect(calls).to.have.length(1);
  });

  describe('against the bodies the server sends', () => {
    it('a wrong type, a missing property, an array item and a body that is not an object', async () => {
      expect(await appliedTo(bodies.wrongType)).to.deep.equal([['count', { type: 'type', message: 'must be a number' }]]);
      expect(await appliedTo(bodies.missingRequired)).to.deep.equal([['count', { type: 'required', message: 'is required' }]]);
      expect(await appliedTo(bodies.arrayItem)).to.deep.equal([['tags.0', { type: 'type', message: 'must be a string' }]]);
      expect(await appliedTo(bodies.rootNotObject)).to.deep.equal([['root', { type: 'type', message: 'must be an object' }]]);
    });

    it('the argument the error belongs to: one of two body arguments, a query argument, a whole query', async () => {
      expect((await appliedTo(bodies.pair)).map(([name]) => name)).to.deep.equal(['second.count']);
      expect(await appliedTo(bodies.enumQuery)).to.deep.equal([['sort', { type: 'enum', message: 'must be one of: asc, desc' }]]);
      expect((await appliedTo(bodies.wholeQuery)).map(([name]) => name)).to.deep.equal(['page']);
    });

    it('localised texts through the messages option', async () => {
      const messages = ({ keyword }: { keyword: string }) => (keyword === 'type' ? 'zly typ' : undefined);
      expect(await appliedTo(bodies.wrongType, { messages })).to.deep.equal([['count', { type: 'type', message: 'zly typ' }]]);
    });
  });
});

describe('applyProblem against react-hook-form setError', function () {
  this.timeout(60000);

  const source = (use: string) =>
    `import type { UseFormReturn } from 'react-hook-form';
import { applyProblem } from '@spinajs/client/runtime';
type Dto = { email: string; name?: string; address: { city: string } };
declare const typed: UseFormReturn<Dto>;
declare const loose: UseFormReturn;
declare const error: unknown;
${use}
`;

  it('accepts the setError of a typed form, an untyped form and a plain function', () => {
    const use = "export const a = applyProblem(error, typed.setError);\nexport const b = applyProblem(error, loose.setError);\nexport const c = applyProblem(error, (name: string, e) => void [name, e]);\nexport const d = applyProblem(error, typed.setError, { messages: () => undefined });";
    expect(typecheckFiles({ 'use.ts': source(use) })).to.deep.equal([]);
  });

  it('refuses a callback that cannot take a string name', () => {
    expect(typecheckFiles({ 'use.ts': source('export const a = applyProblem(error, (name: number) => void name);') })).to.have.length.above(0);
  });
});
