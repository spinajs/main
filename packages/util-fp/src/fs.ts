import { Effect, Option, pipe } from 'effect';
import { Util as DI } from './di.js';
import { Util as C } from './config.js';
import { fs } from '@spinajs/fs';
import { PathLike } from 'node:fs';
import { basename, join } from 'path';

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
    export const readFile = (fs: Option.Option<fs>, path: string, encoding?: BufferEncoding) => {
      return Option.match(fs, {
        onSome: (f) => Option.fromNullable(f),
        onNone: () => getFsProvider('fs-system'),
      }).pipe(
        Effect.flatMap((a) =>
          Effect.tryPromise({
            try: () => a.read(path, encoding),
            catch: (error: Error) => new ReadError(path, error),
          }),
        ),
      );
    };

    /**
     *
     * Copy file from src path to dest path
     *
     * @param src source path
     * @param dst dest path
     * @returns
     */
    export const copyFile = (fs: Option.Option<fs>, src: string, dst: string) => {
      return Option.match(fs, {
        onSome: (f) => Option.fromNullable(f),
        onNone: () => getFsProvider('fs-system'),
      }).pipe(
        Effect.flatMap((a) =>
          Effect.tryPromise({
            try: () => a.copy(src, dst),
            catch: (error: Error) => new CopyError(src, dst, error),
          }),
        ),
        Effect.map(() => [src, dst]),
      );
    };

    /**
     * Deletes file from disk at given path
     *
     * @param file file to delete
     * @returns unklinked file name
     */
    export const unlink = (fs: Option.Option<fs>, file: string) => {
      return Option.match(fs, {
        onSome: (f) => Option.fromNullable(f),
        onNone: () => getFsProvider('fs-system'),
      }).pipe(
        Effect.flatMap((a) =>
          Effect.tryPromise({
            try: () => a.unlink(file),
            catch: (error: Error) => new DeleteError(file, error),
          }),
        ),
        Effect.map(() => file),
      );
    };

    /**
     *
     * @param srcFiles list of files to copy
     * @param dstDir destination dir, file names are taken from srcFiles
     * @returns array of errors and copied files list
     */
    export const copyFileAll = (fs: Option.Option<fs>, files: string[], dstDir: string) => {
      return Effect.partition(files, (f) => copyFile(fs, f, join(dstDir, basename(f))));
    };

    /**
     * deletes all files from local filesystem
     * */
    export const unlinkAll = (fs: Option.Option<fs>, files: string[]) => {
      return Effect.partition(files, (f) => unlink(fs, f), { concurrency: 'inherit' });
    };
  }
}
