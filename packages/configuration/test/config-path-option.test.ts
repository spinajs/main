import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { FrameworkConfiguration } from '../src/index.js';

class Exposed extends FrameworkConfiguration {
  public get Paths(): string[] {
    return this.CustomConfigPaths;
  }
}

describe('--config-path', () => {
  const argv = process.argv;

  afterEach(() => {
    process.argv = argv;
  });

  it('adds a custom config path from the command line, read from the working directory', () => {
    process.argv = [...argv, '--config-path', 'deploy/config'];
    expect(new Exposed().Paths).to.deep.equal([resolve('deploy/config')]);
  });

  it('gives way to cfgCustomPaths, as --apppath gives way to appBaseDir', () => {
    process.argv = [...argv, '--config-path', 'deploy/config'];
    expect(new Exposed({ cfgCustomPaths: ['from/code'] }).Paths).to.deep.equal(['from/code']);
  });

  it('adds nothing without the option', () => {
    expect(new Exposed().Paths).to.deep.equal([]);
  });
});
