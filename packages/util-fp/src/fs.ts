import { Effect, Option, pipe } from 'effect';
import { unlink, copyFile } from 'fs/promises';
import { Util as DI } from './di.js';
import { Util as C } from './config.js';
import { fs } from '@spinajs/fs';

export namespace Util {
  export namespace Fs {
    export class DeleteError {
      readonly _tag = 'DeleteError';

      constructor(public File: string, public Reason: Error) {}
    }

    export class CopyError {
      readonly _tag = 'DeleteError';
      constructor(public SourcePath: string, public DestinationPath: string, public Reason: Error) {}
    }

    export function getFsProvider(providerName?: string) {
      // get provider name or default from config
      const fsProviderName = pipe(
        Option.fromNullable(providerName),
        Effect.orElse(() => C.Config.get<string>('fs.defaultProvider')),
      );

      // try resolve provider
      return fsProviderName.pipe((name) => {
        return DI.Di.resolve<fs>('__file_provider__', [name]);
      });
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
