import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as fs from 'fs';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src/index.js';

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

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          locales: [dir('./lang')],
          templates: [dir('./templates')],
        },
      },
      templates: {
        image: {
          static: {
            portRange: [8080, 8090],
          },
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

async function tp() {
  return await DI.resolve(Templates);
}

describe('templates-image', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    // dispose so the pooled browser is closed and the process can exit
    await DI.dispose();
  });

  it('should render image to file', async () => {
    const t = await tp();

    const file = dir('templates/template_render.png');
    await t.renderToFile(dir('templates/template.png'), { hello: 'world' }, file);

    const exist = fs.existsSync(file);
    expect(exist).to.eq(true);

    fs.unlinkSync(file);
  });

  it('should fail when template not exists', async () => {
    const t = await tp();
    expect(t.renderToFile(dir('templates/template_not_exists.png'), { hello: 'world' }, dir('templates/nope.png'))).to.be.rejected;
  });
});
