import { Class } from '@spinajs/di';
import { ConfigurationSource, IConfigLike } from './definitions.js';

/**
 * Class-factory for an in-memory, DI-injectable configuration source.
 *
 * The Configuration module resolves sources via `Array.ofType(ConfigurationSource)`
 * with fixed constructor args, so we can't pass the config object through the
 * constructor. Instead we bake it ( or a factory returning it ) into a subclass
 * produced here, then register that subclass under `ConfigurationSource`.
 *
 * Platform-free — usable in the browser and Node-testable.
 *
 * @param cfg - the configuration object, or a function returning one ( lazy )
 * @param order - load order ( lower loads first )
 */
let staticSourceCounter = 0;

export function StaticConfigurationSource(cfg: object | (() => object), order = 0): Class<ConfigurationSource> {
  const source = class extends ConfigurationSource {
    public get Order() {
      return order;
    }
    public Load(): Promise<IConfigLike> {
      return Promise.resolve((typeof cfg === 'function' ? cfg() : cfg) as IConfigLike);
    }
  };

  // anonymous class expressions all share the name '' — the DI registry keys by
  // class identity/name, so several unnamed sources would collapse into one.
  // Give each factory product a unique, debuggable name.
  Object.defineProperty(source, 'name', { value: `StaticConfigurationSource${staticSourceCounter++}` });

  return source;
}
