import { compareSchemaRefs } from './schema-compare.js';
import type { Manifest, SocketContractEntry, SocketControllerEntry, TypeRef } from './types.js';

export type SocketContractCode = 'SOCK001' | 'SOCK002' | 'SOCK003';

export interface SocketContractIssue {
  code: SocketContractCode;
  /** Full command or event name */
  subject: string;
  message: string;
}

export const SOCKET_CONTRACT_CODES: Record<SocketContractCode, string> = {
  SOCK001: 'handler-missing',
  SOCK002: 'payload-mismatch',
  SOCK003: 'result-mismatch',
};

const fullName = (prefix: string, name: string): string => (prefix ? `${prefix}.${name}` : name);

/** `x-explicit: 'partial'` marks a schema the analyzer could not fully evaluate: documentation only, never authoritative. */
export function authoritativeSchema(manifest: Manifest, ref: TypeRef | undefined): string | undefined {
  const id = ref?.schema;
  const schema = id === undefined ? undefined : (manifest.schemas[id] as Record<string, unknown> | undefined);
  return id !== undefined && schema !== undefined && schema['x-explicit'] !== 'partial' ? id : undefined;
}

function compare(manifest: Manifest, contract: TypeRef, handler: TypeRef | undefined, direction: 'request' | 'response', code: SocketContractCode, subject: string): SocketContractIssue[] {
  const baseId = authoritativeSchema(manifest, contract);
  const headId = authoritativeSchema(manifest, handler);
  if (baseId === undefined || headId === undefined) return [];

  const findings = compareSchemaRefs(baseId, headId, direction, manifest.schemas, manifest.schemas, subject).filter((f) => f.breaking);
  return findings.length === 0 ? [] : [{ code, subject, message: `${SOCKET_CONTRACT_CODES[code]}: ${subject}: ${findings.map((f) => f.detail).join('; ')}` }];
}

/**
 * Compares the handlers of one socket controller with the contract it is bound to.
 * Payloads are compared as requests (the handler must accept what the contract lets a client send),
 * results as responses (the handler must not return more than the contract promises).
 * Schemas that are missing or `x-explicit: 'partial'` on either side are skipped.
 */
export function checkSocketContract(manifest: Manifest, controller: SocketControllerEntry, contract: SocketContractEntry): SocketContractIssue[] {
  const issues: SocketContractIssue[] = [];
  const commands = new Map(controller.commands.map((c) => [fullName(controller.prefix, c.name), c]));
  const events = new Map(controller.events.map((e) => [fullName(controller.prefix, e.name), e]));

  for (const [name, expected] of Object.entries(contract.commands)) {
    const handler = commands.get(name);
    if (!handler) {
      issues.push({ code: 'SOCK001', subject: name, message: `handler-missing: ${controller.className} has no @Command for ${name} declared by contract ${contract.id}` });
      continue;
    }
    issues.push(...compare(manifest, expected.payload, handler.payload, 'request', 'SOCK002', name));
    issues.push(...compare(manifest, expected.result, handler.result, 'response', 'SOCK003', name));
  }

  for (const [name, payload] of Object.entries(contract.clientEvents)) {
    const handler = events.get(name);
    if (!handler) {
      issues.push({ code: 'SOCK001', subject: name, message: `handler-missing: ${controller.className} has no @OnEvent for ${name} declared by contract ${contract.id}` });
      continue;
    }
    issues.push(...compare(manifest, payload, handler.payload, 'request', 'SOCK002', name));
  }

  return issues;
}

/** The contract bound to a controller entry, `undefined` when it is unbound or absent from the manifest. */
export function contractOfController(manifest: Manifest, controller: SocketControllerEntry): SocketContractEntry | undefined {
  return controller.contract === undefined ? undefined : manifest.socketContracts.find((c) => c.id === controller.contract);
}
