import { Effect } from 'effect';
import { unlink, copyFile } from 'fs/promises';

export namespace Util {
  export namespace Fs {
    export namespace FP {

      export class DeleteError {
        readonly _tag = 'DeleteError';

        constructor(public File: string, public Reason: Error) {}
      }

      export class CopyError {
        readonly _tag = 'DeleteError';
        constructor(public SourcePath: string, public DestinationPath: string, public Reason: Error) {}
      }

      /**
       * 
       * Copy file from src path to dest path
       * 
       * @param src source path
       * @param dst dest path
       * @returns 
       */
      export const copy = (src: string, dst: string) => {
        return Effect.tryPromise({
          try: () => copyFile(src, dst),
          catch: (error: Error) => new CopyError(src, dst, error),
        });
      };

      /**
       * Deletes file from disk at given path
       * 
       * @param file file to delete
       * @returns 
       */
      export const del = (file: string) => {
        return Effect.tryPromise({
          try: () => unlink(file),
          catch: (error: Error) => new DeleteError(file, error),
        });
      };
    }
  }
}
