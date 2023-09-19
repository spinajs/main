import { Injectable } from '@spinajs/di';
import crypto from 'crypto';
import fs from 'node:fs';
import { IOFail } from '@spinajs/exceptions';
import { FileHasher } from './interfaces.js';

@Injectable(FileHasher)
export class DefaultFileHasher extends FileHasher {
  protected HashAlgo: crypto.Hash;

  constructor() {
    super();

    this.HashAlgo = crypto.createHash('sha256');
  }

  public hash(pathToFile: string): Promise<string> {
    if (!fs.existsSync(pathToFile)) {
      throw new IOFail(`File ${pathToFile} not exists locally`);
    }

    return new Promise((resolve, reject) => {
      fs.createReadStream(pathToFile)
        .on('data', (data) => this.HashAlgo.update(data))
        .on('end', () => resolve(this.HashAlgo.digest('hex')))
        .on('error', (err) => reject(err));
    });
  }
}
