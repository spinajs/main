import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { RenderPdfCommand } from '../src/cli/render-pdf.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
          },
        ],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      system: {
        dirs: {
          locales: [dir('./lang')],
          templates: [dir('./templates')],
        },
      },
      templates: {
        pdf: {
          static: { portRange: [8080, 8090] },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          options: {},
          renderDurationWarning: 5000,
          renderTimeout: 30000,
        },
      },
    };
  }
}

describe('render-pdf CLI command', function () {
  this.timeout(20000);

  const outputs: string[] = [];

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    for (const f of outputs.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    await DI.dispose();
  });

  it('renders a raw HTML file to a PDF', async () => {
    const cmd = await DI.resolve(RenderPdfCommand);
    const out = dir('fixtures/out-raw.pdf');
    outputs.push(out);

    await cmd.execute(dir('fixtures/page.html'), { output: out, format: 'A4' });

    expect(fs.existsSync(out)).to.eq(true);
    // a valid PDF starts with the "%PDF" magic bytes
    expect(fs.readFileSync(out).subarray(0, 4).toString('ascii')).to.eq('%PDF');
  });

  it('renders a template to a PDF in template mode', async () => {
    const cmd = await DI.resolve(RenderPdfCommand);
    const out = dir('fixtures/out-tpl.pdf');
    outputs.push(out);

    await cmd.execute(dir('templates/template.pug'), { output: out, template: true, lang: 'en' });

    expect(fs.existsSync(out)).to.eq(true);
    expect(fs.statSync(out).size).to.be.greaterThan(0);
  });

  it('rejects when the raw HTML input does not exist', async () => {
    const cmd = await DI.resolve(RenderPdfCommand);
    await expect(cmd.execute(dir('fixtures/missing.html'), { output: dir('fixtures/nope.pdf') })).to.be.rejected;
  });
});
