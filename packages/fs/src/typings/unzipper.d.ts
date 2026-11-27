import type { Readable } from 'stream';
import type { CentralDirectory } from 'unzipper';

// unzipper's Open.custom() takes options; @types/unzipper declares it without them
declare module 'unzipper' {
  namespace Open {
    function custom(
      source: { size: () => Promise<number>; stream: (offset: number, length: number) => Readable },
      options: { tailSize: number },
    ): Promise<CentralDirectory>;
  }
}
