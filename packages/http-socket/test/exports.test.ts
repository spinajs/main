import 'mocha';
import { expect } from 'chai';
import * as api from '../src/index.js';

describe('@spinajs/http-socket public surface', () => {
  it('exports the server, decorators, extension points, the authz-v3 integration and the shared protocol', () => {
    const names = [
      'SocketServer',
      'SocketHub',
      'SocketConnection',
      'SocketDispatcher',
      'SocketHandlerRegistry',
      'BaseSocketController',
      'SocketController',
      'Command',
      'OnEvent',
      'OnConnect',
      'OnDisconnect',
      'Payload',
      'Connection',
      'Signal',
      'Reason',
      'FromDI',
      'SocketPolicy',
      'SocketPolicyGroup',
      'SocketParameter',
      'SocketArg',
      'SocketArgumentResolver',
      'SocketPrincipalSource',
      'AuthnCredentialSource',
      'credentialRequest',
      'AUTHENTICATION_FAILED',
      'isAllowedOrigin',
      'SocketPrincipalGuard',
      'AuthenticationStage',
      'OrderingStage',
      'InFlightStage',
      'SocketAccess',
      'SocketAccessPolicy',
      'fromPayload',
      'SocketHttpHost',
      'HttpServerHost',
      'SocketCommandStage',
      'STAGE_ORDER',
      'SocketCommandContext',
      'HandleSocketException',
      'SocketErrorMapping',
      'SocketErrorMapper',
      'AccessDeniedMapping',
      'codeMapping',
      'SocketPolicyGate',
      'policyRequest',
      'SerialQueue',
      'TokenBucket',
      'payloadSize',
      'withSlot',
      'assertLimitsConfig',
      'socketMetrics',
      'observeCommand',
      'trackConnection',
      'SOCKET_METRIC_PREFIX',
      'SOCKET_METRIC_KEY_COMMANDS',
      'SOCKET_METRIC_KEY_DURATION',
      'SOCKET_METRIC_KEY_CONNECTIONS',
      'SOCKET_DURATION_BUCKETS_SECONDS',
      'SocketException',
      'PROTOCOL_VERSION',
      'WIRE_EVENTS',
      'SYSTEM_EVENTS',
      'defineContract',
      'isName',
      'NAME_PATTERN',
      'MAX_NAME_LENGTH',
    ];

    for (const name of names) {
      expect(api, name).to.have.property(name);
    }
  });

  it('exposes the hub push API', () => {
    for (const method of ['to', 'toConnection', 'join', 'leave', 'connectionsIn', 'disconnect', 'connection']) {
      expect(api.SocketHub.prototype, method).to.have.property(method);
    }
  });

  it('keeps internal helpers out of the public surface', () => {
    expect(api).to.not.have.property('assertPushName');
  });
});
