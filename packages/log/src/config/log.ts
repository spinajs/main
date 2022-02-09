import { join, normalize, resolve } from "path";

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const config = {
  system: {
    dirs: {
      schemas: [dir("./../schemas")],
    },
  },
  log: {},
};

export default config;
