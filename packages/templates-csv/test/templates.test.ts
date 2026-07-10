import { Templates } from '@spinajs/templates';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import * as fs from 'fs';
import '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const MODEL = {
  fields: ['a', 'b'],
  data: [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ],
};

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
    };
  }
}

async function tp() {
  return await DI.resolve(Templates);
}

describe('templates-csv', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    return new Promise((resolve) => {
      fs.rm(dir('./rendered.csv'), () => {
        resolve();
      });
    });
  });

  it('should render csv to string', async () => {
    const t = await tp();
    // renderer is selected by the `.csv` extension; the path is a dummy,
    // the CSV renderer reads its data from the model, not from a file
    const result = await t.render('data.csv', MODEL);

    expect(result).to.contain('"a","b"');
    expect(result).to.contain('1,2');
    expect(result).to.contain('3,4');
  });

  it('should render csv to file at the given path', async () => {
    const t = await tp();
    const outPath = dir('./rendered.csv');

    await t.renderToFile('data.csv', MODEL, outPath);

    // regression: renderToFile must write to `filePath`, not to the CSV content
    expect(fs.existsSync(outPath)).to.eq(true);

    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).to.contain('"a","b"');
    expect(written).to.contain('1,2');
    expect(written).to.contain('3,4');
  });

  it('should fail fast with a clear error for a malformed model', async () => {
    const t = await tp();

    // crash-early precondition: an opaque parser TypeError becomes a clear message
    await expect(t.render('data.csv', undefined as any)).to.be.rejectedWith(/csv render model requires/);
    await expect(t.render('data.csv', { fields: ['a'] } as any)).to.be.rejectedWith(/csv render model requires/);
    await expect(t.render('data.csv', { data: [] } as any)).to.be.rejectedWith(/csv render model requires/);
  });
});
