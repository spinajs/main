import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const email = {
  system: {
    dirs: {
      cli: [dir('./../cli')],
      jobs: [dir('./../jobs')],
    },
  },
  email: {
    // default email queue / transport
    queue: 'email-queue',
  },
};

export default email;
