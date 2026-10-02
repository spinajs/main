import 'mocha';
import { expect } from 'chai';
import { ClientEventName, ClientEventPayload, CommandName, CommandPayload, CommandResult, ContractOf, DEFAULT_RETRYABLE, ERROR_CODES, ErrorCode, EventName, EventPayload, ID_PATTERN, MAX_ID_LENGTH, MAX_NAME_LENGTH, NAME_PATTERN, PROTOCOL_VERSION, SYSTEM_EVENTS, SocketException, WIRE_EVENTS, defineContract, isCancelFrame, isCommandRequest, isErrorCode, isEventFrame, isSocketError } from '../src/index.js';

type DocsContract = {
  commands: { 'docs.open': [{ id: string }, { title: string }] };
  events: { 'docs.committed': { rev: number } };
  clientEvents: { 'docs.cursor': { x: number } };
};

describe('http-socket-common', () => {
  describe('protocol constants', () => {
    it('speaks protocol version 1', () => {
      expect(PROTOCOL_VERSION).to.equal(1);
    });

    it('names the wire and system events', () => {
      expect(WIRE_EVENTS).to.deep.equal({ command: 'cmd', event: 'evt', chunk: 'chunk', end: 'end', fail: 'fail', credit: 'credit', cancel: 'cancel' });
      expect(SYSTEM_EVENTS).to.deep.equal({ shutdown: 'sys.shutdown', disconnect: 'sys.disconnect' });
    });
  });

  describe('error codes', () => {
    it('lists the 13 codes of the spec', () => {
      expect(ERROR_CODES).to.deep.equal(['invalid_argument', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'failed_precondition', 'unimplemented', 'deadline_exceeded', 'cancelled', 'resource_exhausted', 'unavailable', 'version_mismatch', 'internal']);
    });

    it('marks only deadline, limit and shutdown codes retryable by default', () => {
      expect(ERROR_CODES.filter((c) => DEFAULT_RETRYABLE[c])).to.deep.equal(['deadline_exceeded', 'resource_exhausted', 'unavailable']);
    });

    it('recognises error codes and wire errors', () => {
      expect(isErrorCode('forbidden')).to.be.true;
      expect(isErrorCode('teapot')).to.be.false;
      expect(isSocketError({ code: 'forbidden', message: 'no', retryable: false })).to.be.true;
      expect(isSocketError({ code: 'forbidden', message: 'no' })).to.be.false;
      expect(isSocketError(null)).to.be.false;
    });
  });

  describe('SocketException', () => {
    it('is an Error whose retryable flag defaults from its code', () => {
      const err = new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 250 });
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal('SocketException');
      expect(err.retryable).to.be.true;
      expect(new SocketException('forbidden', 'no').retryable).to.be.false;
      expect(new SocketException('forbidden', 'no', { retryable: true }).retryable).to.be.true;
    });

    it('serialises to a wire error without undefined fields', () => {
      expect(new SocketException('forbidden', 'no').toWire()).to.deep.equal({ code: 'forbidden', message: 'no', retryable: false });
      expect(new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 250, details: { limit: 1 }, errorId: 'e1' }).toWire()).to.deep.equal({
        code: 'resource_exhausted',
        message: 'slow down',
        retryable: true,
        retryAfterMs: 250,
        details: { limit: 1 },
        errorId: 'e1',
      });
    });

    it('round-trips through fromWire', () => {
      const wire = { code: 'unavailable' as ErrorCode, message: 'restarting', retryable: true, retryAfterMs: 1000 };
      const err = SocketException.fromWire(wire);
      expect(err).to.be.instanceOf(SocketException);
      expect(err.toWire()).to.deep.equal(wire);
    });
  });

  describe('envelope guards', () => {
    it('accepts well-formed command requests', () => {
      expect(isCommandRequest({ id: 'r1', name: 'docs.open', payload: { id: 'a' } })).to.be.true;
      expect(isCommandRequest({ id: 'r1', name: 'docs.open' })).to.be.true;
      expect(isCommandRequest({ id: 'r1', name: 'docs.open', deadline: 500, idempotencyKey: 'c:1', traceparent: '00-abc' })).to.be.true;
    });

    it('rejects malformed command requests', () => {
      expect(isCommandRequest(null)).to.be.false;
      expect(isCommandRequest({ name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: '', name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: 'x'.repeat(MAX_ID_LENGTH + 1), name: 'x' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: '' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: 'x', deadline: '5' })).to.be.false;
      expect(isCommandRequest({ id: 'r1', name: 'x', idempotencyKey: 5 })).to.be.false;
    });

    it('accepts only printable ASCII ids ( ID_PATTERN ), so an id cannot break a log line', () => {
      expect(ID_PATTERN.test('a-B_9:{}~!')).to.be.true;
      for (const id of ['r-1', '550e8400-e29b-41d4-a716-446655440000', '!~', 'x'.repeat(MAX_ID_LENGTH)]) {
        expect(isCommandRequest({ id, name: 'x' }), id).to.be.true;
        expect(isCancelFrame({ id }), id).to.be.true;
      }

      for (const id of ['r 1', 'r1\n', 'r1\r', '\u0000', 'r\u007f', '\u017c', '\u202e1r', '\t']) {
        expect(ID_PATTERN.test(id), JSON.stringify(id)).to.be.false;
        expect(isCommandRequest({ id, name: 'x' }), JSON.stringify(id)).to.be.false;
        expect(isCancelFrame({ id }), JSON.stringify(id)).to.be.false;
      }
    });

    it('bounds command and event names to MAX_NAME_LENGTH characters of NAME_PATTERN', () => {
      const longest = 'x'.repeat(MAX_NAME_LENGTH);
      expect(MAX_NAME_LENGTH).to.equal(128);
      expect(NAME_PATTERN.test('docs.open')).to.be.true;

      for (const name of ['docs.open', 'a:b-c_d.E9', longest]) {
        expect(isCommandRequest({ id: 'r1', name }), name).to.be.true;
        expect(isEventFrame({ name, payload: null }), name).to.be.true;
      }

      for (const name of [longest + 'x', 'docs.open\n', 'docs open', 'docs/open', 'dócs', '<script>']) {
        expect(isCommandRequest({ id: 'r1', name }), JSON.stringify(name)).to.be.false;
        expect(isEventFrame({ name, payload: null }), JSON.stringify(name)).to.be.false;
      }
    });

    it('checks event and cancel frames', () => {
      expect(isEventFrame({ name: 'docs.cursor', payload: { x: 1 } })).to.be.true;
      expect(isEventFrame({ payload: 1 })).to.be.false;
      expect(isEventFrame({ name: '', payload: 1 })).to.be.false;
      expect(isCancelFrame({ id: 'r1' })).to.be.true;
      expect(isCancelFrame({ id: 1 })).to.be.false;
    });
  });

  describe('contracts', () => {
    const contract = defineContract<DocsContract>();

    it('returns a runtime marker that carries no data', () => {
      expect(contract).to.deep.equal({ kind: 'socket-contract' });
    });

    it('derives checked names and payload types', () => {
      const command: CommandName<DocsContract> = 'docs.open';
      const payload: CommandPayload<DocsContract, 'docs.open'> = { id: 'a' };
      const result: CommandResult<DocsContract, 'docs.open'> = { title: 't' };
      const event: EventName<DocsContract> = 'docs.committed';
      const eventPayload: EventPayload<DocsContract, 'docs.committed'> = { rev: 1 };
      const clientEvent: ClientEventName<DocsContract> = 'docs.cursor';
      const clientPayload: ClientEventPayload<DocsContract, 'docs.cursor'> = { x: 1 };
      const inferred: ContractOf<typeof contract> = { commands: { 'docs.open': [{ id: 'a' }, { title: 't' }] }, events: { 'docs.committed': { rev: 1 } }, clientEvents: { 'docs.cursor': { x: 1 } } };
      // @ts-expect-error unknown command names must not type-check
      const unknown: CommandName<DocsContract> = 'docs.nope';
      expect([command, payload, result, event, eventPayload, clientEvent, clientPayload, inferred, unknown]).to.have.length(9);
    });
  });
});
