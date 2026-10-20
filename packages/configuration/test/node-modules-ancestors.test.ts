import 'mocha';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import { IConfigLike } from '@spinajs/configuration-common';
import { BaseFileSource } from '../src/sources.js';

class Probe extends BaseFileSource {
  public static ancestors(startDir: string) {
    return BaseFileSource.nodeModulesAncestors(startDir);
  }

  public static hoistingRoot(startDir: string) {
    return BaseFileSource.findHoistingRoot(startDir);
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

describe('BaseFileSource node_modules lookup', () => {
  let tmp: string;

  const dir = (...parts: string[]) => {
    const p = join(tmp, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const packageJson = (at: string, json: object) => fs.writeFileSync(join(at, 'package.json'), JSON.stringify(json));

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'spinajs-ancestors-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('a checkout nested in another one', () => {
    let outer: string;
    let inner: string;
    let app: string;

    beforeEach(() => {
      outer = dir('outer');
      packageJson(outer, { name: 'root', workspaces: ['packages/*'] });
      dir('outer', 'node_modules', '@spinajs', 'di');

      inner = dir('outer', '.claude', 'worktrees', 'wt');
      packageJson(inner, { name: 'root', workspaces: ['packages/*'] });
      dir('outer', '.claude', 'worktrees', 'wt', 'node_modules', '@spinajs', 'di');

      app = dir('outer', '.claude', 'worktrees', 'wt', 'packages', 'app');
      packageJson(app, { name: '@spinajs/app' });
    });

    it('stops at the workspace root and never reaches the enclosing checkout', () => {
      expect(Probe.ancestors(app)).to.deep.equal([inner]);
    });

    it('keeps a member node_modules, nearest first', () => {
      dir('outer', '.claude', 'worktrees', 'wt', 'packages', 'app', 'node_modules');
      expect(Probe.ancestors(app)).to.deep.equal([app, inner]);
    });

    it('takes the hoisting root from inside the workspace, or none', () => {
      expect(Probe.hoistingRoot(app)).to.equal(inner);

      fs.rmSync(join(inner, 'node_modules', '@spinajs', 'di'), { recursive: true });
      expect(Probe.hoistingRoot(app)).to.equal(null);
    });

    it('counts a pnpm-workspace.yaml as a workspace root', () => {
      packageJson(inner, { name: 'root' });
      fs.writeFileSync(join(inner, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(Probe.ancestors(app)).to.deep.equal([inner]);
    });
  });

  it('walks every ancestor when no workspace root encloses the start dir', () => {
    const top = dir('top');
    dir('top', 'node_modules');
    const app = dir('top', 'app');
    packageJson(app, { name: 'app' });
    dir('top', 'app', 'node_modules');

    expect(Probe.ancestors(app).slice(0, 2)).to.deep.equal([app, top]);
  });

  it('ignores a package.json it cannot parse', () => {
    const top = dir('top');
    dir('top', 'node_modules');
    const app = dir('top', 'app');
    fs.writeFileSync(join(app, 'package.json'), '{ not json');

    expect(Probe.ancestors(app)[0]).to.equal(top);
  });
});
