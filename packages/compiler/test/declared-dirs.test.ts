import 'mocha';
import { expect } from 'chai';
import { analyzePackage } from '../src/index.js';

const OPTIONS = { tsconfig: 'test/fixtures/dirs-pkg/tsconfig.json', packageRoot: 'test/fixtures/dirs-pkg' };

describe('what a package lists for the sections discovery scans', () => {
  it('lists every class of an app, but never an abstract base', async () => {
    const fragment = await analyzePackage(OPTIONS);
    expect(fragment.controllers.map((c) => c.className)).to.deep.equal(['RealController', 'ElsewhereController']);
    expect(fragment.schedules.map((s) => s.className)).to.deep.equal(['OptInTask']);
    expect(fragment.migrations.map((m) => m.className)).to.deep.equal(['Dirs_2026_01_01_00_00_00']);
  });

  it('lists every workflow of an app', async () => {
    const fragment = await analyzePackage(OPTIONS);
    expect(fragment.workflows?.map((w) => w.className)).to.deep.equal(['Stray', 'Listed']);
  });

  describe('declaredDirsOnly', () => {
    it('lists a controller only under a controllers dir the config declares', async () => {
      const fragment = await analyzePackage({ ...OPTIONS, declaredDirsOnly: true });
      expect(fragment.controllers.map((c) => c.className)).to.deep.equal(['RealController']);
    });

    it('drops an opt-in schedule when the config declares no schedules dir', async () => {
      const fragment = await analyzePackage({ ...OPTIONS, declaredDirsOnly: true });
      expect(fragment.schedules).to.deep.equal([]);
    });

    it('drops migrations of a package that declares no migrations dir', async () => {
      const fragment = await analyzePackage({ ...OPTIONS, declaredDirsOnly: true });
      expect(fragment.migrations).to.deep.equal([]);
    });

    it('lists a workflow only under a workflows dir the config declares', async () => {
      const fragment = await analyzePackage({ ...OPTIONS, declaredDirsOnly: true });
      expect(fragment.workflows?.map((w) => w.className)).to.deep.equal(['Listed']);
    });
  });

  describe('effectiveDirs', () => {
    it('marks a workflow outside system.dirs.workflows as mounted by a registration, with CMP006, and lists no scan file for workflows', async () => {
      const fragment = await analyzePackage({ ...OPTIONS, effectiveDirs: { workflows: ['src/workflows'] } });
      expect(fragment.workflows?.map((w) => [w.className, w.mountedBy])).to.deep.equal([
        ['Stray', 'di'],
        ['Listed', undefined],
      ]);
      expect(fragment.diagnostics.filter((d) => d.code === 'CMP006' && d.source?.file === 'src/flows/Stray.ts')).to.have.length(1);
      expect((fragment.scanFiles ?? []).map((f) => f.section)).to.not.include('workflows');
    });
  });
});
