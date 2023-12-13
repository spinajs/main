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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return this.Alghoritm === creationOptions[0].alghoritm;
  }

  public Name: string;

  protected HashAlgo: crypto.Hash;

  constructor( public Alghoritm?: string, public HashOptions?: crypto.HashOptions) {
    super();

    this.Alghoritm = this.Alghoritm || 'sha256';
    this.HashAlgo = crypto.createHash(this.Alghoritm, this.HashOptions);
  }

  public async hash(pathToFile: string): Promise<string> {
    if (!fs.existsSync(pathToFile)) {
      throw new IOFail(`File ${pathToFile} not exists`);
    }

    return new Promise((resolve, reject) => {
      fs.createReadStream(pathToFile)
        .on('data', (data) => this.HashAlgo.update(data))
        .on('end', () => resolve(this.HashAlgo.digest('hex')))
        .on('error', (err) => reject(err));
    });
  }
}
