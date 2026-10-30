import { Inject, Injectable } from '@spinajs/di';
import { MAILER, SETTINGS } from './tokens.js';
import { token } from '@spinajs/di';

export const UNREGISTERED = token<string>('__unregistered__');

@Injectable()
@Inject(MAILER as never, SETTINGS as never)
export class NeedsRegistered {}

@Injectable()
@Inject(UNREGISTERED as never)
export class NeedsMissing {}
