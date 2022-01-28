import { Exception } from "@spinajs/exceptions";
import { ErrorObject } from "ajv";
/**
 * The exception that is thrown when JSON entity is checked against schema and is invalid
 */
 export class ValidationFailed extends Exception {
    public parameter: any;
  
    constructor(message: string, validationErrors: IValidationError[]) {
      super(message);
      this.parameter = validationErrors;
    }
  }

  // tslint:disable-next-line
  export interface IValidationError extends ErrorObject
  {

  }