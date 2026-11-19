import { BadRequest, CodedHttpException, Forbidden } from '@spinajs/exceptions';

/** The entry is not `Type: 'file'` or declares no `Meta.file.fs`. */
export class NotAFileEntry extends BadRequest {}

/** The uploaded file breaks a rule, the entry validator or the value schema; the message is shown to the admin. */
export class ConfigFileRejected extends BadRequest {}

/** The update scope of the principal matched no row, so nothing was written. */
export class ConfigWriteRefused extends Forbidden {}

/** `invalid_body`: the body breaks the `UpdateConfigDto` schema. `invalid_value`: `Value` or `Default` breaks the entry type, `Meta` or slug schema. */
export type ConfigurationUpdateErrorCode = 'configuration.invalid_body' | 'configuration.invalid_value';

/** A refused `PATCH /configuration/:slug`, answered `400 { code, message }` by `CodedHttpExceptionResponse`. */
export class ConfigurationUpdateRefused extends CodedHttpException<ConfigurationUpdateErrorCode> {
  constructor(code: ConfigurationUpdateErrorCode, message: string) {
    super(400, code, message);
  }
}
