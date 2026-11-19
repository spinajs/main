import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DefaultControllerCache } from '../src/cache.js';
import type { IControllerDocumentation } from '../src/cache.js';

interface IPrivateExtractors {
  extractAll(file: string, className: string): { documentation: IControllerDocumentation };
}

const SOURCE = `
export class ExportController {
  /**
   * Two media types
   * @produces application/json
   * @produces   text/plain; version=0.0.4
   */
  public metrics() {}

  /**
   * An empty tag
   * @produces
   */
  public empty() {}

  /**
   * No tag
   * @returns The rows
   */
  public plain() {}
}
`;

describe('DefaultControllerCache @produces tag', () => {
  let dir: string;
  let methods: IControllerDocumentation['methods'];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'produces-tag-'));
    const file = join(dir, 'ExportController.ts');
    writeFileSync(file, SOURCE);
    const cache = new DefaultControllerCache();
    methods = (cache as unknown as IPrivateExtractors).extractAll(file, 'ExportController').documentation.methods;
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps every tag in order, trimmed, parameters as written', () => {
    expect(methods.metrics.produces).to.deep.equal(['application/json', 'text/plain; version=0.0.4']);
  });

  it('records an empty tag as an empty value, so the document build can refuse it', () => {
    expect(methods.empty.produces).to.deep.equal(['']);
  });

  it('leaves produces unset without the tag', () => {
    expect(methods.plain).to.not.have.property('produces');
  });
});
