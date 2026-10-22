import { DI } from '@spinajs/di';

/** The schemas registered in the root container after `register` ran; the root registrations are restored. */
export function registeredSchemasAfter(register: () => void): unknown[] {
  const schemas = (): unknown[] => DI.get(Array.ofType<unknown>('__configurationSchema__')) ?? [];
  const saved = [...schemas()];
  try {
    register();
    return schemas();
  } finally {
    DI.uncache('__configurationSchema__');
    for (const schema of saved) DI.register(schema as never).asValue('__configurationSchema__');
  }
}
