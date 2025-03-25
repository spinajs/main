import { Exception } from '@spinajs/exceptions';
import { IDriverOptions } from './interfaces.js';

/**
 * Exception thrown when functionality is not supported
 */
export class OrmException extends Exception {
  constructor(message?: string, public driver?: Partial<IDriverOptions>, public query?: string, public bindings? : any, public inner?: Error | unknown) {
    super(message, inner);

    if (this.driver) {
      this.message = `Error during execution statement on connection ${this.driver.Name} at ${this.driver.User}@${this.driver.Host}, inner exception: ${this.inner ?? 'none'}, message: ${message}`;
    }
  }

  public toString() {}
}

/**
 * Exception thrown when functionality is not supported
 */
export class OrmNotFoundException extends OrmException {}
