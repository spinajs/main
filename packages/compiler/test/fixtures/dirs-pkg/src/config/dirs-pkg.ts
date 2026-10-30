import { join } from 'path';

const dir = (path: string) => [join(process.cwd(), 'node_modules', 'dirs-pkg', 'lib', path)];

export default {
  system: {
    dirs: {
      controllers: [...dir('controllers')],
      schedules: [] as string[],
    },
  },
};
