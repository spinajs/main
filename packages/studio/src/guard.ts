export interface StudioMountSettings {
  /** `studio.enabled` */
  readonly enabled: unknown;
  /** `studio.allowProduction` */
  readonly allowProduction: unknown;
  /** `configuration.isProduction`, already normalised by `isProduction()` of `@spinajs/authz`. */
  readonly isProduction: boolean;
}

export class StudioMountRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StudioMountRefused';
  }
}

/** False while Studio is off; throws {@link StudioMountRefused} when it is on in production without `studio.allowProduction`. */
export function assertStudioMountable(settings: StudioMountSettings): boolean {
  if (settings.enabled !== true) return false;
  if (settings.isProduction && settings.allowProduction !== true) {
    throw new StudioMountRefused('studio.enabled is true in production but studio.allowProduction is not; Spina Studio is not mounted');
  }
  return true;
}
