import { join, normalize, resolve } from 'path';

const EVENTS = 'upload-events';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'upload', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'upload', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

/**
 * The alias puts the upload tables on the app's default connection; an app's db.Aliases.upload wins, since package config
 * merges first (authz-orm/src/config/db.ts:1). Every event starts on a black hole until the app routes it to a real
 * queue (docs/upload/09-events.md), as users does (users/src/config/users.ts:23-47). The upload.* defaults live in the
 * schema (src/schema.ts).
 */
const upload = {
  system: {
    dirs: {
      // CLI commands are found by a filesystem scan; without this entry upload:sweep is unreachable in a consuming app.
      cli: [...dir('cli')],
    },
  },
  db: {
    Aliases: {
      upload: 'default',
    },
  },
  queue: {
    routing: {
      UploadCreated: { connection: EVENTS },
      UploadPartStored: { connection: EVENTS },
      UploadPartRejected: { connection: EVENTS },
      UploadContentChecked: { connection: EVENTS },
      UploadAssemblyStarted: { connection: EVENTS },
      UploadPartCorrupted: { connection: EVENTS },
      UploadAssemblyReleased: { connection: EVENTS },
      UploadCompleted: { connection: EVENTS },
      UploadFailed: { connection: EVENTS },
      UploadAborted: { connection: EVENTS },
      UploadExpired: { connection: EVENTS },
      UploadPurged: { connection: EVENTS },
    },
    connections: [
      {
        name: EVENTS,
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'upload-jobs',
        defaultTopicChannel: 'upload-events',
      },
    ],
  },
};

export default upload;
