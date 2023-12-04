import { Effect, Option, pipe } from 'effect';
import { unlink as unlinkFS, copyFile as copyFileFS, readFile as readFileFS, FileHandle } from 'fs/promises';
import { Util as DI } from './di.js';
import { Util as C } from './config.js';
import { fs } from '@spinajs/fs';
import { OpenMode, PathLike } from 'node:fs';

export namespace Util {
  export namespace Fs {
    export class DeleteError {
      readonly _tag = 'DeleteError';

      constructor(public File: string, public Reason: Error) {}
    }

    export class CopyError {
      readonly _tag = 'CopyError';
      constructor(public SourcePath: string, public DestinationPath: string, public Reason: Error) {}
    }

    export class ReadError {
      readonly _tag = 'ReadError';
      constructor(public Path: PathLike, public Reason: Error) {}
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
     * Reads entire file into buffer
     *
     * @param path file to reaf from
     * @param options
     * @returns
     */
    export const readFile = (
      path: PathLike,
      options?: {
        encoding?: null | undefined;
        flag?: OpenMode | undefined;
      } | null,
    ) => {
      return Effect.tryPromise({
        try: () => readFileFS(path, options),
        catch: (error: Error) => new ReadError(path, error),
      });
    };

    /**
     *
     * Copy file from src path to dest path
     *
     * @param src source path
     * @param dst dest path
     * @returns
     */
    export const copyFile = (src: string, dst: string) => {
      return Effect.tryPromise({
        try: () => copyFileFS(src, dst),
        catch: (error: Error) => new CopyError(src, dst, error),
      });
    };

    /**
     * Deletes file from disk at given path
     *
     * @param file file to delete
     * @returns
     */
    export const unlink = (file: string) => {
      return Effect.tryPromise({
        try: () => unlinkFS(file),
        catch: (error: Error) => new DeleteError(file, error),
      });
    };
  }
}
