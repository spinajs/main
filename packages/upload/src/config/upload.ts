const EVENTS = 'upload-events';

/**
 * The alias puts the upload tables on the app's default connection; an app's db.Aliases.upload wins, since package config
 * merges first (authz-orm/src/config/db.ts:1). Every event starts on a black hole (spec §6.2, D14), as users does
 * (users/src/config/users.ts:23-47). The upload.* defaults live in the schema (src/schema.ts).
 */
const upload = {
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
