import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { InvalidArgument } from '@spinajs/exceptions';

import { parseContentDigest } from '../src/index.js';

// RFC 9530 §2 examples: digests of the content `{"hello": "world"}`.
const SHA256 = 'X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=';
const SHA512 = 'WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==';
const bytes = (base64: string) => Buffer.from(base64, 'base64');

describe('parseContentDigest', () => {
  it('uses real digests in its fixtures', () => {
    expect(createHash('sha256').update('{"hello": "world"}').digest('base64')).to.eq(SHA256);
    expect(createHash('sha512').update('{"hello": "world"}').digest('base64')).to.eq(SHA512);
  });

  const parses: [string, string, [string, Buffer][]][] = [
    ['one member', `sha-256=:${SHA256}:`, [['sha-256', bytes(SHA256)]]],
    ['two members, in order', `sha-256=:${SHA256}:, sha-512=:${SHA512}:`, [['sha-256', bytes(SHA256)], ['sha-512', bytes(SHA512)]]],
    ['members joined without spaces', `sha-256=:${SHA256}:,sha-512=:${SHA512}:`, [['sha-256', bytes(SHA256)], ['sha-512', bytes(SHA512)]]],
    ['spaces and tabs around the comma', `sha-256=:${SHA256}: \t, \tsha-512=:${SHA512}:`, [['sha-256', bytes(SHA256)], ['sha-512', bytes(SHA512)]]],
    ['leading and trailing whitespace', ` \tsha-256=:${SHA256}:  `, [['sha-256', bytes(SHA256)]]],
    ['an upper-case key, lower-cased', `SHA-256=:${SHA256}:`, [['sha-256', bytes(SHA256)]]],
    ['base64 without padding', `sha-256=:${SHA256.replace(/=+$/, '')}:`, [['sha-256', bytes(SHA256)]]],
    ['an empty byte sequence', 'sha-256=::', [['sha-256', Buffer.alloc(0)]]],
    ['parameters of every bare item type, dropped', `sha-256=:${SHA256}:;a=1;b=-2.5;c="x\\"y";d=tok/en:1;e=:AQ==:;f=?0;g`, [['sha-256', bytes(SHA256)]]],
    ['a space after the parameter semicolon', `sha-256=:${SHA256}:; a=1`, [['sha-256', bytes(SHA256)]]],
    ['an empty field', '', []],
    ['a field of spaces', '   ', []],
  ];

  for (const [name, header, expected] of parses) {
    it(`parses ${name}`, () => {
      expect([...parseContentDigest(header)]).to.deep.eq(expected);
    });
  }

  const refuses: [string, string][] = [
    ['a key without a value', 'sha-256'],
    ['a token value', 'sha-256=abc'],
    ['an integer value', 'sha-256=1'],
    ['an inner list value', `sha-256=(:${SHA256}:)`],
    ['an unterminated byte sequence', `sha-256=:${SHA256}`],
    ['a character outside base64', 'sha-256=:ab$d:'],
    ['base64 of an impossible length', 'sha-256=:abcde:'],
    ['padding inside base64', 'sha-256=:ab==cd==:'],
    ['too much padding', 'sha-256=:ab===:'],
    ['a repeated key', `sha-256=:${SHA256}:, sha-256=:${SHA256}:`],
    ['a key repeated in another case', `sha-256=:${SHA256}:, SHA-256=:${SHA256}:`],
    ['a trailing comma', `sha-256=:${SHA256}:,`],
    ['a missing comma', `sha-256=:${SHA256}: sha-512=:${SHA512}:`],
    ['a key starting with a digit', `256=:${SHA256}:`],
    ['a space before the equals sign', `sha-256 =:${SHA256}:`],
    ['a space before a parameter', `sha-256=:${SHA256}: ;a=1`],
    ['an unparseable parameter value', `sha-256=:${SHA256}:;a=@x`],
    ['an unterminated parameter string', `sha-256=:${SHA256}:;a="x`],
    ['an integer parameter of 16 digits', `sha-256=:${SHA256}:;a=1234567890123456`],
    ['a decimal parameter with 4 fraction digits', `sha-256=:${SHA256}:;a=1.2345`],
    ['a parameter byte sequence outside base64', `sha-256=:${SHA256}:;a=:a$:`],
  ];

  for (const [name, header] of refuses) {
    it(`refuses ${name}`, () => {
      expect(() => parseContentDigest(header)).to.throw(InvalidArgument);
    });
  }

  it('does not echo the header value in the error', () => {
    expect(() => parseContentDigest('sha-256=:secret-value:')).to.throw(InvalidArgument).with.property('message').that.does.not.contain('secret-value');
  });
});
