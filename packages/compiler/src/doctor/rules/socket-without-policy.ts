import type { Diagnostic } from '@spinajs/manifest';
import { configAt, diagnostic, type DoctorRule } from '../rule.js';
import { entryName, withoutIgnored } from './authz-entries.js';

export const socketWithoutPolicy: DoctorRule = {
  code: 'AUTHZ003',
  describe: 'Every socket command and event has @SocketAccess or @SocketPolicy on it or on its class',
  run(manifest, ctx) {
    const allowed = configAt(ctx.config, 'http.socket.access.default') === 'allow';
    const out: Diagnostic[] = [];
    for (const e of manifest.authz?.entryPoints ?? []) {
      if ((e.kind !== 'socket-command' && e.kind !== 'socket-event') || e.access.length > 0) continue;
      const effect = allowed ? "it runs unguarded while http.socket.access.default is 'allow', which 5.0 removes" : 'the server denies it (no_policy)';
      out.push(diagnostic('AUTHZ003', allowed ? 'warning' : 'error', `${entryName(e)} has no @SocketAccess or @SocketPolicy on it or on its class: ${effect}.`, e.source));
    }
    return withoutIgnored(manifest, out);
  },
};
