import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractControllers, extractSocketControllers, extractValues } from '../../src/index.js';

const load = (name: string) => {
  const loaded = createProgramFromTsconfig('test/fixtures/generator-features/tsconfig.json');
  const ctx = createContext(loaded, 'gen', 'test/fixtures/generator-features');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith(name))!;
  return { ctx, file };
};

describe('@HandleException values', () => {
  const { ctx, file } = load('errors.ts');
  const values = extractValues(ctx, file);
  const map = values.filter((v) => v.token === '__http_error_map__').map((v) => [v.mapKey, v.value]);

  it('emits one entry per exception with the response class and its status', () => {
    expect(map).to.deep.equal([
      ['ResourceNotFound', { response: 'MissingThing', status: 404 }],
      ['InvalidArgument', { response: 'BadThing', status: 404 }],
      ['TypeError', { response: 'BadThing', status: 404 }],
      ['RangeError', { response: 'Plain', status: 200 }],
      ['EvalError', { response: 'Unknown' }],
    ]);
  });

  it('marks entries as map values and reports an unknown status', () => {
    expect(values.every((v) => v.kind === 'map')).to.equal(true);
    expect(ctx.diagnostics.filter((d) => d.severity === 'info' && /status/.test(d.message))).to.have.length(1);
  });
});

describe('socket stream results', () => {
  const { ctx, file } = load('stream.ts');
  const [stream] = extractSocketControllers(ctx, file);
  const byName = (n: string) => stream.commands.find((c) => c.name === n)!;

  it('derives the item type and sets stream for async iterables', () => {
    for (const name of ['iterable', 'generator', 'iterator']) {
      expect(byName(name).result, name).to.deep.equal({ text: 'Item', schema: 'spinajs/gen/Item' });
      expect(byName(name).stream, name).to.equal(true);
    }
  });

  it('leaves ordinary results alone', () => {
    expect(byName('plain').stream).to.equal(undefined);
    expect(byName('plain').result.text).to.equal('Item[]');
  });
});

describe('file params', () => {
  const { ctx, file } = load('files.ts');
  const [controller] = extractControllers(ctx, file);

  it('keep their type text but get no schema', () => {
    for (const route of controller.routes) {
      expect(route.params[0].kind).to.equal('FromFile');
      expect(route.params[0].runtimeType.schema, route.handler).to.equal(undefined);
      expect(route.params[0].runtimeType.text).to.match(/IUploadedFile/);
    }
    expect(ctx.diagnostics.filter((d) => d.code === 'SCH001')).to.deep.equal([]);
    expect([...ctx.schemaRegistry.keys()]).to.deep.equal([]);
  });
});
