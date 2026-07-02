import { Injectable, PerInstanceCheck } from '@spinajs/di';
import crypto from 'crypto';
import fs from 'node:fs';
import { IOFail } from '@spinajs/exceptions';
import { FileHasher } from './interfaces.js';

@Injectable(FileHasher)
@PerInstanceCheck()
export class DefaultFileHasher extends FileHasher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public __checkInstance__(creationOptions: any): boolean {
    // hasher is resolved with the algorithm passed as a bare string constructor arg
    // ( eg. DI.resolve(FileHasher, ['md5']) ), so compare against creationOptions[0] directly.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const requestedAlgo = creationOptions?.[0] ?? 'sha256';
    return this.Alghoritm === requestedAlgo;
  }

  public Name!: string;

  constructor(public Alghoritm?: string, public HashOptions?: crypto.HashOptions) {
    super();

    this.Alghoritm = this.Alghoritm || 'sha256';
  }

  public async hash(pathToFile: string): Promise<string> {
    if (!fs.existsSync(pathToFile)) {
      throw new IOFail(`File ${pathToFile} not exists`);
    }

    if(!this.Alghoritm){
      throw new IOFail(`Hashing algorithm is not specified for file hasher. Please provide algorithm as constructor parameter or set default algorithm in configuration`);
    }

    const algo = crypto.createHash(this.Alghoritm, this.HashOptions);

    return new Promise((resolve, reject) => {
      fs.createReadStream(pathToFile)
        .on('data', (data) => algo.update(data))
        .on('end', () => resolve(algo.digest('hex')))
        .on('error', (err) => reject(err));
    });
  }
}
