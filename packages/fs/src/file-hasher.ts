import { Injectable, PerInstanceCheck } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import crypto, { BinaryToTextEncoding } from 'crypto';
import fs from 'node:fs';
import { IOFail } from '@spinajs/exceptions';
import { FileHasher } from './interfaces.js';

/**
 * Hard fallback algorithm used when nothing is provided and no config default is set.
 */
const DEFAULT_ALGORITHM = 'sha256';

/**
 * Default {@link FileHasher} implementation backed by node's `crypto` module.
 *
 * The algorithm is fixed per instance and provided as the first constructor
 * argument ( eg. `DI.resolve(FileHasher, ['md5'])` ). When no algorithm is
 * given it falls back to the value configured under `fs.hasher.defaultAlgorithm`,
 * and finally to {@link DEFAULT_ALGORITHM} ( sha256 ).
 *
 * Instances are cached per algorithm via {@link PerInstanceCheck} /
 * {@link __checkInstance__}, so resolving the same algorithm twice reuses the
 * same hasher while different algorithms get distinct instances.
 */
@Injectable(FileHasher)
@PerInstanceCheck()
export class DefaultFileHasher extends FileHasher {
  /**
   * Default algorithm read from configuration ( `fs.hasher.defaultAlgorithm` ),
   * falling back to {@link DEFAULT_ALGORITHM} when the key is not set.
   *
   * Exposed as a lazily evaluated config property so both the constructor and
   * {@link __checkInstance__} resolve the default the same way.
   */
  @Config('fs.hasher.defaultAlgorithm', { defaultValue: DEFAULT_ALGORITHM })
  protected ConfiguredAlgorithm!: string;

  /**
   * Per-instance cache predicate used by {@link PerInstanceCheck}.
   *
   * Returns `true` when this instance was created for the algorithm requested in
   * `creationOptions`. The requested algorithm is resolved exactly like the
   * constructor does ( explicit arg, else the configured default ), so cached
   * instances match reliably.
   *
   * @param creationOptions constructor arguments the container is resolving with
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public __checkInstance__(creationOptions: any): boolean {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const requestedAlgo = creationOptions?.[0] ?? this.ConfiguredAlgorithm;
    return this.Algorithm === requestedAlgo;
  }

  /**
   * @param Algorithm hash algorithm to use ( eg. `sha256`, `md5` ). When omitted,
   *                  the configured default ( `fs.hasher.defaultAlgorithm` ) or
   *                  sha256 is used.
   * @param HashOptions optional node `crypto` hash options ( eg. `outputLength`
   *                    for XOF algorithms such as shake256 )
   */
  constructor(public Algorithm?: string, public HashOptions?: crypto.HashOptions) {
    super();

    this.Algorithm = this.Algorithm || this.ConfiguredAlgorithm;
  }

  /**
   * Creates a `crypto.Hash` for the configured algorithm.
   *
   * The algorithm is validated against the platform's supported hashes first so
   * an unsupported/typo'd algorithm produces a clear {@link IOFail} instead of a
   * cryptic native crypto error.
   *
   * @throws {IOFail} when the configured algorithm is not supported
   */
  protected createHasher(): crypto.Hash {
    const algo = this.Algorithm as string;

    if (!crypto.getHashes().includes(algo)) {
      throw new IOFail(`Unsupported hash algorithm '${algo}'. Use one of: ${crypto.getHashes().join(', ')}`);
    }

    return crypto.createHash(algo, this.HashOptions);
  }

  /**
   * Hashes the content of a file by streaming it through the hash.
   *
   * @param pathToFile absolute path to the file to hash
   * @param encoding digest output encoding ( default `hex` )
   * @returns the digest string in the requested encoding
   * @throws {IOFail} when the file does not exist, the algorithm is unsupported,
   *                  or the file cannot be read
   */
  public async hash(pathToFile: string, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    if (!fs.existsSync(pathToFile)) {
      throw new IOFail(`File ${pathToFile} not exists`);
    }

    const hasher = this.createHasher();

    return new Promise((resolve, reject) => {
      fs.createReadStream(pathToFile)
        .on('data', (data) => hasher.update(data))
        .on('end', () => resolve(hasher.digest(encoding)))
        .on('error', (err) => reject(new IOFail(`Cannot read file ${pathToFile} for hashing`, err)));
    });
  }

  /**
   * Hashes raw in-memory data.
   *
   * @param data string or binary data to hash
   * @param encoding digest output encoding ( default `hex` )
   * @returns the digest string in the requested encoding
   * @throws {IOFail} when the configured algorithm is unsupported
   */
  public async hashData(data: string | Uint8Array, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    const hasher = this.createHasher();
    hasher.update(data);
    return hasher.digest(encoding);
  }

  /**
   * Hashes the content of a readable stream by consuming it to the end.
   *
   * @param stream readable stream to consume
   * @param encoding digest output encoding ( default `hex` )
   * @returns the digest string in the requested encoding
   * @throws {IOFail} when the configured algorithm is unsupported or the stream errors
   */
  public async hashStream(stream: NodeJS.ReadableStream, encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
    const hasher = this.createHasher();

    return new Promise((resolve, reject) => {
      stream
        .on('data', (data) => hasher.update(data))
        .on('end', () => resolve(hasher.digest(encoding)))
        .on('error', (err) => reject(new IOFail(`Error while hashing stream`, err)));
    });
  }
}
