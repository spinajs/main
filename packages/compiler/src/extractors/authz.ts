import type ts from 'typescript';
import type { AuthzSection } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';

type Resource = AuthzSection['resources'][number];

export interface AuthzInputs {
  resources: Resource[];
}

const RESOURCE_ACTIONS = ['read', 'create', 'update', 'delete'];
const IGNORE = /\/\/\s*spinajs-authz-ignore\s+(AUTHZ\d{3})\s*:\s*(.*\S)/g;

function ignoresIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): AuthzSection['ignores'] {
  return files.flatMap((file) =>
    [...file.text.matchAll(IGNORE)].map((m) => {
      const { line, character } = file.getLineAndCharacterOfPosition(m.index);
      return { code: m[1], reason: m[2], source: { ...ctx.sourceRef(file), line: line + 1, col: character + 1 } };
    }),
  );
}

/** What authz-orm's adapter registers for every resource type at runtime. */
function modelPermissions(resources: Resource[]): AuthzSection['permissions'] {
  const types = [...new Set(resources.map((r) => r.type))];
  return types.flatMap((type) => RESOURCE_ACTIONS.map((action) => ({ name: `${type}:${action}`, declaredIn: 'model' as const })));
}

/** The package's `authz` section; undefined when it declares nothing. `findings` stay empty until the flow pass. */
export function authzSectionOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], inputs: AuthzInputs): AuthzSection | undefined {
  const section: AuthzSection = { resources: inputs.resources, permissions: modelPermissions(inputs.resources), entryPoints: [], findings: [], ignores: ignoresIn(files, ctx) };
  return section.resources.length || section.ignores.length ? section : undefined;
}
