import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { RenderImageCommand } from '../src/cli/render-image.js';

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
        image: {
          static: { portRange: [8080, 8090] },
          args: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          },
          renderDurationWarning: 5000,
          renderTimeout: 30000,
        },
      },
    };
  }
}

describe('render-image CLI command', function () {
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

  it('renders a raw HTML file to a PNG at a fixed viewport', async () => {
    const cmd = await DI.resolve(RenderImageCommand);
    const out = dir('fixtures/out-raw.png');
    outputs.push(out);

    await cmd.execute(dir('fixtures/page.html'), { output: out, width: '400', height: '300' });

    expect(fs.existsSync(out)).to.eq(true);
    const buf = fs.readFileSync(out);
    expect(buf.readUInt32BE(16)).to.eq(400); // PNG width
    expect(buf.readUInt32BE(20)).to.eq(300); // PNG height
  });

  it('renders a template to a PNG in template mode', async () => {
    const cmd = await DI.resolve(RenderImageCommand);
    const out = dir('fixtures/out-tpl.png');
    outputs.push(out);

    await cmd.execute(dir('templates/template.pug'), { output: out, template: true, lang: 'en' });

    expect(fs.existsSync(out)).to.eq(true);
    expect(fs.statSync(out).size).to.be.greaterThan(0);
  });

  it('rejects when the raw HTML input does not exist', async () => {
    const cmd = await DI.resolve(RenderImageCommand);
    await expect(cmd.execute(dir('fixtures/missing.html'), { output: dir('fixtures/nope.png') })).to.be.rejected;
  });
});
