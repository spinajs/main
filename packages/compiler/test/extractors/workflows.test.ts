import { expect } from 'chai';
import { analyzePackage, createContext, createProgramFromTsconfig, extractWorkflows } from '../../src/index.js';

describe('extractWorkflows', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-workflow/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-workflow', 'test/fixtures/pkg-workflow');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('order.ts'))!;
  const entries = extractWorkflows(ctx, file);

  it('name, version, class and the literal signals of run(), deduplicated; a computed name is "*"', () => {
    expect(entries).to.deep.equal([
      { name: 'order', version: 1, className: 'OrderV1', signals: [{ name: 'approved' }], source: { file: 'src/order.ts', line: 5, col: 1, package: 'pkg-workflow' } },
      {
        name: 'order',
        version: 2,
        className: 'OrderV2',
        signals: [{ name: 'approved', permission: 'orders:approve' }, { name: 'note' }, { name: '*' }],
        source: { file: 'src/order.ts', line: 12, col: 1, package: 'pkg-workflow' },
      },
    ]);
  });

  it('WF004 flags wall-clock and random reads in run(), but not inside a step callback', () => {
    const wf004 = ctx.diagnostics.filter((d) => d.code === 'WF004').map((d) => [d.severity, d.message, d.source?.line]);
    expect(wf004).to.deep.equal([
      ['warning', 'OrderV2.run calls new Date() outside a step; use ctx.now() so a replay sees the same value', 20],
      ['warning', 'OrderV2.run calls Math.random() outside a step; use ctx.random() so a replay sees the same value', 20],
    ]);
  });

  it('analyzePackage puts the workflows into the fragment, and omits the section without any', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-workflow/tsconfig.json', packageRoot: 'test/fixtures/pkg-workflow' });
    expect(fragment.workflows?.map((w) => `${w.name}@${w.version}`)).to.deep.equal(['order@1', 'order@2']);
    const basic = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    expect(basic).to.not.have.property('workflows');
  });

  const names = createProgramFromTsconfig('test/fixtures/pkg-workflow/tsconfig.names.json');
  const extractFrom = (suffix: string) => {
    const fileCtx = createContext(names, 'pkg-workflow', 'test/fixtures/pkg-workflow');
    const entries = extractWorkflows(fileCtx, names.sourceFiles.find((f) => f.fileName.endsWith(suffix))!);
    return { entries, diagnostics: fileCtx.diagnostics.map((d) => [d.code, d.severity, d.message, d.source?.line]) };
  };

  it('reads names, permissions and options held in constants; WF004 still checks a step key', () => {
    const { entries, diagnostics } = extractFrom('consts.ts');
    expect(entries.map(({ name, version, className, signals }) => ({ name, version, className, signals }))).to.deep.equal([
      { name: 'consts', version: 3, className: 'Consts', signals: [{ name: 'approved', permission: 'orders:approve' }, { name: 'ship', permission: 'orders:ship' }] },
    ]);
    expect(diagnostics.filter((d) => d[0] !== 'CMP001')).to.deep.equal([
      ['WF004', 'warning', 'Consts.run calls Date.now() outside a step; use ctx.now() so a replay sees the same value', 15],
      ['WF006', 'warning', 'UnreadVersion: the @Workflow name or version cannot be read at build time; the class is left out of the manifest', 19],
      ['WF006', 'warning', 'UnreadOptions: the @Workflow name or version cannot be read at build time; the class is left out of the manifest', 24],
    ]);
  });

  it("WF005 flags a literal event name with '#' or '*', which waitForEvent refuses, and leaves it out", () => {
    const { entries, diagnostics } = extractFrom('names.ts');
    expect(entries[0]?.signals).to.deep.equal([{ name: 'ok' }]);
    expect(diagnostics).to.deep.equal([
      ['WF005', 'warning', `Names.run waits for event "a#b", which waitForEvent refuses: event names cannot contain '#' or '*'`, 6],
      ['WF005', 'warning', `Names.run waits for event "all*", which waitForEvent refuses: event names cannot contain '#' or '*'`, 7],
    ]);
  });
});
