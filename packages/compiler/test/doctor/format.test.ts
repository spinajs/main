import 'mocha';
import { expect } from 'chai';
import { formatDiagnostics, summarize } from '../../src/doctor/format.js';
import { src } from './fixture.js';

const diags = [
  { code: 'DI001', severity: 'error' as const, message: "A injects 'X' (constructor argument 0) but nothing registers it", source: src('src/a.ts', 4) },
  { code: 'CFG002', severity: 'error' as const, message: "system.dirs.cli entry '/gone' does not exist" },
  { code: 'CFG001', severity: 'warning' as const, message: "Config path 'b.c' is read but no configuration schema declares module 'b'", source: src('src/b.ts', 2) },
  { code: 'CFG003', severity: 'info' as const, message: "Oidc will not register: config 'authn.oidc.enabled' is falsy", source: src('src/o.ts', 1) },
];

describe('formatDiagnostics', () => {
  it('text', () => {
    expect(formatDiagnostics(diags, 'text')).to.deep.equal([
      "error   DI001    src/a.ts:4:1  A injects 'X' (constructor argument 0) but nothing registers it",
      "error   CFG002                 system.dirs.cli entry '/gone' does not exist",
      "warning CFG001   src/b.ts:2:1  Config path 'b.c' is read but no configuration schema declares module 'b'",
      "info    CFG003   src/o.ts:1:1  Oidc will not register: config 'authn.oidc.enabled' is falsy",
      '2 error(s), 1 warning(s), 1 info',
    ]);
  });

  it('github', () => {
    expect(formatDiagnostics(diags, 'github')).to.deep.equal([
      "::error file=src/a.ts,line=4,col=1,title=DI001::A injects 'X' (constructor argument 0) but nothing registers it",
      "::error title=CFG002::system.dirs.cli entry '/gone' does not exist",
      "::warning file=src/b.ts,line=2,col=1,title=CFG001::Config path 'b.c' is read but no configuration schema declares module 'b'",
      "::notice file=src/o.ts,line=1,col=1,title=CFG003::Oidc will not register: config 'authn.oidc.enabled' is falsy",
    ]);
  });

  it('github escapes workflow-command special characters', () => {
    const tricky = [{ code: 'X:1', severity: 'error' as const, message: '100% bad,\nnext\r', source: src('src/a,b:c.ts', 3) }];
    expect(formatDiagnostics(tricky, 'github')).to.deep.equal(['::error file=src/a%2Cb%3Ac.ts,line=3,col=1,title=X%3A1::100%25 bad,%0Anext%0D']);
  });

  it('json', () => {
    const [line] = formatDiagnostics(diags, 'json');
    expect(JSON.parse(line)).to.deep.equal({ diagnostics: diags, summary: { error: 2, warning: 1, info: 1 } });
  });

  it('summarize counts by severity', () => {
    expect(summarize(diags)).to.deep.equal({ error: 2, warning: 1, info: 1 });
  });
});
