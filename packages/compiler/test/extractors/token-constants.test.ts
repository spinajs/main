import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices, extractValues } from '../../src/index.js';

describe('token<T>() constants', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/tokens/tsconfig.json');
  const ctx = createContext(loaded, 'tokens-fixture', 'test/fixtures/tokens');
  const file = (name: string) => loaded.sourceFiles.find((f) => f.fileName.endsWith(name))!;

  it('records the key of an imported or re-exported token in registeredAs', () => {
    const services = extractServices(ctx, file('register.ts'));
    expect(services.map((s) => [s.className, s.registeredAs])).to.deep.equal([
      ['SmtpMailer', ['__mailer__']],
      ['OtherMailer', ['__mailer__', 'OtherMailer']],
    ]);
  });

  it('records asToken of a plain value and asValue(T.key) under the token key', () => {
    expect(extractValues(ctx, file('register.ts')).map((v) => v.token)).to.deep.equal(['__settings__', '__manifest__', '__settings__']);
  });

  it('records DI.resolve(T) under the token key', () => {
    const sender = extractServices(ctx, file('consumer.ts')).find((s) => s.className === 'Sender')!;
    expect(sender.imperativeResolves?.map(({ token, awaited }) => ({ token, awaited }))).to.deep.equal([
      { token: '__mailer__', awaited: false },
      { token: '__settings__', awaited: true },
    ]);
  });

  it('keeps an ordinary identifier as its own name', () => {
    const sender = extractServices(ctx, file('consumer.ts')).find((s) => s.className === 'Sender')!;
    expect(sender.ctorInjects).to.deep.equal(['SmtpMailer']);
  });
});

describe('token<T>() constants declared in a dependency build output', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/tokens/tsconfig.json');
  const ctx = createContext(loaded, 'tokens-fixture', 'test/fixtures/tokens');

  it('reads the key through the declaration map of a workspace package', () => {
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('foreign.ts'))!;
    const reader = extractServices(ctx, file).find((s) => s.className === 'ManifestReader')!;
    expect(reader.imperativeResolves?.map((r) => r.token)).to.deep.equal(['__manifest__.settings', '__log__', '__manifest__']);
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP005')).to.have.length(0);
  });
});
