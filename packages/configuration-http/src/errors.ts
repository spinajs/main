import { BadRequest } from '@spinajs/exceptions';

/** The entry is not `Type: 'file'` or declares no `Meta.file.fs`. */
export class NotAFileEntry extends BadRequest {}

/** The uploaded file breaks a rule, the entry validator or the value schema; the message is shown to the admin. */
export class ConfigFileRejected extends BadRequest {}
