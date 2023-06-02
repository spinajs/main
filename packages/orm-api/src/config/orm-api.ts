import { DI } from '@spinajs/di';
import { join, normalize, resolve } from 'path';

const isESMMode = DI.get<boolean>('__esmMode__');

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const ormHttp = {
  system: {
    dirs: {
      controllers: [dir(`node_modules/@spinajs/orm-http/lib/${isESMMode ? 'mjs/controllers' : 'cjs/controllers'}`)],
      schemas: [dir(`node_modules/@spinajs/orm-http/lib/${isESMMode ? 'mjs/schemas' : 'cjs/schemas'}`)],
    },
  },
  api: {
    endpoint: {
      transformer: {
        service: 'JsonApiCollectionTransformer',
      },
    },
  },
};

export default ormHttp;
