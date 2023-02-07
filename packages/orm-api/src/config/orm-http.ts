import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), path)));
}

const ormHttp = {
  system: {
    dirs: {
      controllers: [dir('./../controllers')],
      schemas: [dir('./../schemas')],
    },
  },

  api: {
    endpoint: {
      transformer: {
        service: 'JsonApiCollectionTransofrmer',
      }
    }
  }
};

export default ormHttp;
