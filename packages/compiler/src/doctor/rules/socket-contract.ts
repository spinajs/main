import { checkSocketContract, type Diagnostic, type Manifest, type SocketContractEntry, type TypeRef } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

type Schema = { properties?: Record<string, Schema>; required?: unknown };

/** Only `<levels up>/<property>` is followed: anything else may lead where a schema's `properties` do not show. */
function pointerProblem(pointer: string, scope: Schema[]): string | undefined {
  const match = /^(\d+)\/([^/]+)$/.exec(pointer);
  const owner = match ? scope.at(-1 - Number(match[1])) : undefined;
  if (!match || !owner?.properties) return undefined;

  const name = match[2];
  if (!Object.hasOwn(owner.properties, name)) return `$data pointer ${pointer} names no property, so the rule never applies`;
  const required = Array.isArray(owner.required) && owner.required.includes(name);
  return required ? undefined : `$data pointer ${pointer} names optional property ${name}: a client that omits it skips the rule`;
}

/** Ajv skips a `$data` rule whose value is absent, without a word; `scope` is the schema of each enclosing object. */
function dataPointerProblems(schema: Schema, enclosing: Schema[] = []): string[] {
  const scope = [...enclosing, schema];
  const own = Object.values(schema as Record<string, { $data?: unknown } | null>).flatMap((rule) => {
    const pointer = rule?.$data;
    return typeof pointer === 'string' ? (pointerProblem(pointer, scope) ?? []) : [];
  });
  return [...own, ...Object.values(schema.properties ?? {}).flatMap((member) => dataPointerProblems(member, scope))];
}

function contractDataPointers(manifest: Manifest, contract: SocketContractEntry): Diagnostic[] {
  const payloads: Array<[string, TypeRef]> = [...Object.entries(contract.commands).map(([name, command]): [string, TypeRef] => [name, command.payload]), ...Object.entries(contract.clientEvents)];
  return payloads.flatMap(([name, payload]) => {
    const schema = payload.schema === undefined ? undefined : (manifest.schemas[payload.schema] as Schema | undefined);
    return (schema ? dataPointerProblems(schema) : []).map((problem) => diagnostic('SOCK006', 'warning', `${contract.id}: ${name}: ${problem}`, contract.source));
  });
}

export const socketContract: DoctorRule = {
  code: 'SOCK001',
  describe:
    'a socket controller bound to a contract lacks a handler the contract declares (SOCK001), or its payload (SOCK002) or result (SOCK003) is incompatible with it; two contracts share an id (SOCK005); a contract payload has a $data pointer that names no property or an optional one (SOCK006)',
  run(manifest): Diagnostic[] {
    const out: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const contract of manifest.socketContracts) {
      if (seen.has(contract.id)) {
        out.push(diagnostic('SOCK005', 'error', `socket contract id ${contract.id} is declared more than once; give each defineContract a unique id`, contract.source));
      }
      seen.add(contract.id);
      out.push(...contractDataPointers(manifest, contract));
    }
    for (const controller of manifest.socketControllers) {
      if (controller.contract === undefined) continue;
      const contract = manifest.socketContracts.find((c) => c.id === controller.contract);
      if (!contract) {
        out.push(diagnostic('SOCK001', 'error', `${controller.className}: bound contract ${controller.contract} is not in the manifest`, controller.source));
        continue;
      }
      for (const issue of checkSocketContract(manifest, controller, contract)) {
        out.push(diagnostic(issue.code, issue.code === 'SOCK001' ? 'error' : 'warning', `${controller.className}: ${issue.message}`, controller.source));
      }
    }
    return out;
  },
};
