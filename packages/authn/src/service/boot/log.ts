import { auditLog } from '../../audit/log.js';


// TODO: it should use spinajs/log objects, not custom log mechanism  !
const log = auditLog('authn-boot');
const said = new Set<string>();

/** Every child container with the same configuration repeats the boot warnings; each is logged once per process. */
export function warnOnce(message: string): void {
  if (said.has(message)) return;
  said.add(message);
  log.warn(message);
}
