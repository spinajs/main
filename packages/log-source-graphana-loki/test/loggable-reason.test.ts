import 'mocha';
import { expect } from 'chai';

import { loggableReason } from '../src/loggable-endpoint.js';

const ENDPOINT = 'http://pl4nteduser:p%40ss%3Apl4ntedpct@127.0.0.1:4318/ingest/0f8c2a4be1d94c3e9a7b5d6e8f901234/v1/traces?token=planted-token&weird=PLWEIRD&PLQBARE#PLFRAG';
const SAFE = 'http://127.0.0.1:4318/ingest/***/v1/traces';
const PLANTED = ['pl4nteduser', 'p%40ss', 'p@ss', 'pl4ntedpct', 'planted-token', 'PLWEIRD', 'PLQBARE', 'PLFRAG', '0f8c2a4be1d94c3e9a7b5d6e8f901234'];

function expectNonePlanted(reason: string): void {
  for (const planted of PLANTED) expect(reason).to.not.contain(planted);
}

describe('loggableReason', () => {
  it('is the error class and message', () => {
    expect(loggableReason(new URIError('URI malformed'), ENDPOINT)).to.eq('URIError: URI malformed');
  });

  it('prints the endpoint the message repeats in its redacted form', () => {
    const reason = loggableReason(new Error(`Could not parse user-provided export URL: '${ENDPOINT}'`), ENDPOINT);
    expect(reason).to.eq(`Error: Could not parse user-provided export URL: '${SAFE}'`);
  });

  it('redacts the endpoint the message repeats normalized, percent-encoded or cut short', () => {
    const upper = ENDPOINT.replace('http://', 'HTTP://');
    const echoes: Array<[endpoint: string, echo: string]> = [
      [upper, new URL(upper).href],
      [ENDPOINT, encodeURIComponent(ENDPOINT)],
      [ENDPOINT, encodeURI(ENDPOINT)],
      [ENDPOINT, `${ENDPOINT.slice(0, 50)}...`],
      [ENDPOINT, ENDPOINT.slice(0, 20)],
    ];
    for (const [endpoint, echo] of echoes) {
      const reason = loggableReason(new Error(`refused ${echo} now`), endpoint);
      expectNonePlanted(reason);
      expect(reason).to.match(/^Error: refused .* now$/);
    }
  });

  it('masks a part of the endpoint the message names on its own', () => {
    for (const part of ['p@ss:pl4ntedpct', 'pl4nteduser', 'token=planted-token', 'PLWEIRD', 'PLQBARE', '#PLFRAG', '0f8c2a4be1d94c3e9a7b5d6e8f901234']) {
      const reason = loggableReason(new Error(`collector said ${part}`), ENDPOINT);
      expectNonePlanted(reason);
      expect(reason).to.contain('***');
    }
  });

  it('redacts an endpoint that does not parse, whole or cut short', () => {
    const endpoint = 'http://user:planted-secret@127.0.0.1:99999/v1/traces?token=planted-token';
    expect(loggableReason(new Error(`bad '${endpoint}'`), endpoint)).to.eq("Error: bad '<not a URL>'");
    expect(loggableReason(new Error(`bad '${endpoint.slice(0, 40)}'`), endpoint)).to.eq("Error: bad '<not a URL>'");
  });

  it('names a thrown value that is not an Error by its text, redacted', () => {
    expect(loggableReason(`down: ${ENDPOINT}`, ENDPOINT)).to.eq(`down: ${SAFE}`);
  });
});
