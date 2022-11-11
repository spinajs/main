//import { join, normalize, resolve } from 'path';

// function dir(path: string) {
//   return resolve(normalize(join(__dirname, path)));
// }

module.exports = {
  system: {
    // model & migrations are registered in queue bootstrap
    // dirs: {
    //   migrations: [dir('./../migrations')],
    //   models: [dir('./../models')],
    // },
  },
  queue: {
    // by default, all messages are sent to black hole
    // becouse some modules use queues to pass events eg. user login
    // but not always in project we want to use queue or have queue server
    default: 'black-hole',
    connections: [
      {
        name: 'black-hole',
        transport: 'BlackHoleQueueClient',
      },
    ],
  },
};
