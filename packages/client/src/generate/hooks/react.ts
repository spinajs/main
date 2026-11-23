import { companionHeader, manifestHashCheck, siblingSpecifier, type SiblingImports } from '../companion.js';
import type { ClientModel } from '../model.js';
import { withUseClient } from './directive.js';

/** `client.react.ts`: the client context both hook libraries read. Plain `.ts` with `createElement`, so apps need no JSX setting. */
export function emitReactContext(model: ClientModel, options: SiblingImports = {}): string {
  const lines = [
    companionHeader('react', model),
    "import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react';",
    `import type { AppClient, manifestHash } from '${siblingSpecifier(options)}';`,
    '',
    ...manifestHashCheck(model),
    '',
    'const AppClientContext = createContext<AppClient | null>(null);',
    '',
    'export function AppClientProvider(props: { client: AppClient; children?: ReactNode }): ReactElement {',
    '  return createElement(AppClientContext.Provider, { value: props.client }, props.children);',
    '}',
    '',
    'export function useAppClient(): AppClient {',
    '  const client = useContext(AppClientContext);',
    "  if (!client) throw new Error('useAppClient: wrap the tree in <AppClientProvider client={createAppClient(...)}>');",
    '  return client;',
    '}',
  ];
  return withUseClient(`${lines.join('\n')}\n`);
}
