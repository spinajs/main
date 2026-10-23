import { createHash } from 'node:crypto';
import chai from 'chai';
import chaiHttp from 'chai-http';

import { sha256hex } from '../../support/flow.js';
import { appPort } from './app.js';

chai.use(chaiHttp);

export const BASE = '/projects/p-1/uploads';

type Method = 'get' | 'head' | 'post' | 'put' | 'delete';

export interface CallOptions {
  /** Sent as x-test-owner; null sends none. Default 'alice'. */
  readonly owner?: string | null;
  readonly headers?: Record<string, string>;
}

/** `Connection: close`: a reused keep-alive socket can be reset by the server closing it at that moment (scheduler-http/test/common.ts:28-29). */
export function call(method: Method, path: string, options: CallOptions = {}) {
  const owner = options.owner === undefined ? 'alice' : options.owner;
  const request = chai.request(`http://127.0.0.1:${appPort()}`)[method](path).set('Connection', 'close').set('Accept', 'application/json').set(options.headers ?? {});
  return owner === null ? request : request.set('x-test-owner', owner);
}

export const digestOf = (bytes: Buffer): string => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;

/** Part `part` of `file` in the test config's 4-byte parts. */
export const partOf = (file: Buffer, part: number): Buffer => file.subarray((part - 1) * 4, part * 4);

/** The JSON body typed, so the tests never read fields off `any`. */
export const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

export function createUpload(file: Buffer, body: Record<string, unknown> = {}, options: CallOptions = {}) {
  return call('post', BASE, options).send({ name: 'notes.txt', size: file.length, sha256: sha256hex(file), ...body });
}

export interface PartOptions extends CallOptions {
  /** The Content-Digest header; null sends none. Default: the sha-256 of `bytes`. */
  readonly digest?: string | null;
}

export function sendPart(id: string, part: number, bytes: Buffer, options: PartOptions = {}) {
  const request = call('put', `${BASE}/${id}/parts/${part}`, options).set('Content-Type', 'application/octet-stream');
  const digest = options.digest === undefined ? digestOf(bytes) : options.digest;
  return (digest === null ? request : request.set('Content-Digest', digest)).send(bytes);
}
