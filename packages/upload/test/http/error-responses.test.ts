import 'mocha';
import { expect } from 'chai';
import { ActionRefused } from '@spinajs/hooks';
import type { Response } from '@spinajs/http';

import { UPLOAD_ERRORS, UPLOAD_ERROR_CODES, UploadError } from '../../src/index.js';
import { hookRefusalResponse, uploadErrorBody, uploadErrorResponse } from '../../src/http/index.js';
import { uploadEnv } from '../support/env.js';

interface Sent {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
}

/** Runs a Response against a recording express response, as __handle_response__ does. */
async function sent(response: Response): Promise<Sent> {
  const out: Sent = { status: 0, headers: {}, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    setHeader(name: string, value: unknown) {
      out.headers[name.toLowerCase()] = value;
    },
    json(body?: unknown) {
      out.body = body;
    },
  };
  const send = await response.execute({} as never, res as never);
  if (send) send({} as never, res as never);
  return out;
}

describe('upload error responses', () => {
  // jsonResponse reads http.cookie.options from the Configuration (responses.ts:21-27).
  before(uploadEnv);

  it('answers every UPLOAD_ERRORS code with its status and { code, message }', async () => {
    expect(UPLOAD_ERROR_CODES).to.include.members(['upload.part_lost', 'upload.file_lost']);
    for (const code of UPLOAD_ERROR_CODES) {
      expect(await sent(uploadErrorResponse(new UploadError(code, `refused: ${code}`))), code).to.deep.include({ status: UPLOAD_ERRORS[code], body: { code, message: `refused: ${code}` } });
    }
  });

  it('keeps the status the throw chose over the table (unsupported content is 415)', async () => {
    expect((await sent(uploadErrorResponse(new UploadError('upload.unsupported_type', 'image/png', {}, 415)))).status).to.eq(415);
  });

  it('adds details only when the error carries some', () => {
    expect(uploadErrorBody(new UploadError('upload.parts_missing', 'missing', { parts: [2, 3] }))).to.deep.equal({ code: 'upload.parts_missing', message: 'missing', details: { parts: [2, 3] } });
    expect(uploadErrorBody(new UploadError('upload.not_found', 'gone'))).to.deep.equal({ code: 'upload.not_found', message: 'gone' });
  });

  it('answers a refusing hook with 403 and the code the hook chose', async () => {
    expect(await sent(hookRefusalResponse(new ActionRefused('upload.create', 'upload.quota', 'quota exceeded')))).to.deep.include({ status: 403, body: { code: 'upload.quota', message: 'quota exceeded' } });
  });
});
