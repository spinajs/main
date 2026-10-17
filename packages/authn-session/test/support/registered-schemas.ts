import { DI } from '@spinajs/di';

/** The schemas registered in the root container after `register` ran; the root registrations are restored. */
export function registeredSchemasAfter(register: () => void): unknown[] {
  const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
  const saved = [...schemas()];
  try {
    register();
    return schemas();
  } finally {
    DI.uncache('__configurationSchema__' as never);
    for (const schema of saved) DI.register(schema as never).asValue('__configurationSchema__');
  }
}
