import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { AuthenticationFailed, BadRequest, Forbidden, InvalidArgument, InvalidOperation, JsonValidationFailed, MethodNotImplemented, NotSupported, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { DataValidator } from '@spinajs/validation';
import { AccessDenied, FALSE, Unauthenticated } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { ErrorCode, SocketException } from '@spinajs/http-socket-common';
import { AccessDeniedMapping, ForbiddenMapping, HandleSocketException, SocketErrorMapper, codeMapping, resolveSocketErrorMapping } from '../src/errors.js';
import { configure } from './harness.js';

export class ErrDocumentLocked extends Forbidden {}
export class ErrEditWindowClosed extends Forbidden {}

@HandleSocketException(ErrEditWindowClosed)
export class ErrEditWindowClosedMapping extends codeMapping('failed_precondition') {}

describe('socket error mapping', function () {
  this.timeout(15000);

  let mapper: SocketErrorMapper;

  beforeEach(async () => {
    await configure();
    mapper = DI.resolve(SocketErrorMapper);
  });

  afterEach(() => {
    sinon.restore();
  });

  const rows: Array<[Error, ErrorCode]> = [
    [new InvalidArgument('bad id'), 'invalid_argument'],
    [new BadRequest('bad request'), 'invalid_argument'],
    [new JsonValidationFailed('bad json'), 'invalid_argument'],
    [new AuthenticationFailed('who are you'), 'unauthenticated'],
    [new Unauthenticated('authentication required'), 'unauthenticated'],
    [new Forbidden('not yours'), 'forbidden'],
    [new ResourceNotFound('no such doc'), 'not_found'],
    [new ResourceDuplicated('doc exists'), 'conflict'],
    [new InvalidOperation('doc is archived'), 'failed_precondition'],
    [new NotSupported('no export'), 'unimplemented'],
    [new MethodNotImplemented('later'), 'unimplemented'],
  ];

  for (const [error, code] of rows) {
    it(`maps ${error.constructor.name} to ${code}, not retryable`, () => {
      expect(mapper.toWire(error, 'test')).to.deep.equal({ code, message: error.message, retryable: false });
    });
  }

  it('maps a domain subclass through the prototype chain', () => {
    expect(mapper.toWire(new ErrDocumentLocked('locked by bob'), 'test')).to.deep.equal({ code: 'forbidden', message: 'locked by bob', retryable: false });
  });

  it('prefers an exact registration over an inherited one', () => {
    expect(resolveSocketErrorMapping(new ErrEditWindowClosed('x'))).to.equal(ErrEditWindowClosedMapping);
    expect(resolveSocketErrorMapping(new ErrDocumentLocked('x'))).to.equal(ForbiddenMapping);
    expect(mapper.toWire(new ErrEditWindowClosed('too late'), 'test').code).to.equal('failed_precondition');
  });

  it('maps authz-v3 AccessDenied to forbidden with the permission, resource and reason of the http 403 body (B23)', () => {
    const decision: Decision = {
      allowed: false,
      permission: 'doc:read',
      resource: { type: 'doc', id: 'd1' },
      principal: { type: 'user', id: '1' },
      residual: FALSE,
      fields: { read: [], write: [] },
      roles: {},
      reason: { code: 'locked', model: 'm1', priority: 50, sortKey: 'k', detail: 'd' },
      domain: 'root',
    };

    expect(resolveSocketErrorMapping(new AccessDenied(decision))).to.equal(AccessDeniedMapping);
    expect(mapper.toWire(new AccessDenied(decision, 'no'), 'test')).to.deep.equal({
      code: 'forbidden',
      message: 'no',
      retryable: false,
      details: { permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, reason: { code: 'locked', model: 'm1', detail: 'd' } },
    });
  });

  it('puts the invalid field into details', () => {
    expect(mapper.toWire(new InvalidArgument('bad id', 'id'), 'test')).to.deep.equal({ code: 'invalid_argument', message: 'bad id', retryable: false, details: { field: 'id' } });
  });

  it('maps validation failures with their details', async () => {
    const validator = await DI.resolve(DataValidator);
    let failure: unknown;
    try {
      validator.validate({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, {});
    } catch (err) {
      failure = err;
    }

    const wire = mapper.toWire(failure, 'test');
    expect(wire.code).to.equal('invalid_argument');
    expect(wire.retryable).to.be.false;
    expect(wire.details).to.be.an('array').that.is.not.empty;
    expect((wire.details as Array<{ rule: string }>)[0].rule).to.equal('required');
  });

  it('passes socket exceptions through with their own code and retry hints', () => {
    expect(mapper.toWire(new SocketException('deadline_exceeded', 'late'), 'test')).to.deep.equal({ code: 'deadline_exceeded', message: 'late', retryable: true });
    expect(mapper.toWire(new SocketException('cancelled', 'stop'), 'test')).to.deep.equal({ code: 'cancelled', message: 'stop', retryable: false });
    expect(mapper.toWire(new SocketException('resource_exhausted', 'slow down', { retryAfterMs: 100 }), 'test')).to.deep.equal({ code: 'resource_exhausted', message: 'slow down', retryable: true, retryAfterMs: 100 });
    expect(mapper.toWire(new SocketException('unavailable', 'restarting'), 'test')).to.deep.equal({ code: 'unavailable', message: 'restarting', retryable: true });
  });

  it('maps anything else to internal with an errorId it logs', () => {
    const log = sinon.spy((mapper as unknown as { Log: { error: (...args: unknown[]) => void } }).Log, 'error');
    const wire = mapper.toWire(new Error('kaput'), 'command docs.open');

    expect(wire.code).to.equal('internal');
    expect(wire.retryable).to.be.false;
    expect(wire.message).to.equal('kaput');
    expect(wire.errorId).to.match(/^[0-9a-f-]{36}$/);
    expect((wire.details as { stack?: string }).stack).to.contain('kaput');
    expect(log.calledOnce).to.be.true;
    expect(String(log.firstCall.args[1])).to.contain(wire.errorId!);
  });

  it('maps thrown non-errors to internal', () => {
    const wire = mapper.toWire('boom', 'test');
    expect(wire.code).to.equal('internal');
    expect(wire.message).to.equal('boom');
  });

  it('hides the internal message in production', async () => {
    await configure({ configuration: { isProduction: true } });
    const wire = DI.resolve(SocketErrorMapper).toWire(new Error('db password is hunter2'), 'test');

    expect(wire.errorId).to.be.a('string');
    expect(wire).to.deep.equal({ code: 'internal', message: 'Internal server error', retryable: false, errorId: wire.errorId });
  });
});
