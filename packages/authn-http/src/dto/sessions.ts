import { fieldSchema, sessionHandleField } from '@spinajs/authn/schemas';

export const SESSION_HANDLE_PARAM = fieldSchema('authn.param.sessionHandle', sessionHandleField);
