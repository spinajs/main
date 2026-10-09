import { Schema } from '@spinajs/validation';
import { BaseController, BasePath, Body, Header, Ok, Post } from '../../src/index.js';

export const SECRET_DTO_SCHEMA = {
  type: 'object',
  properties: {
    reauthPassword: { type: 'string', minLength: 8 },
    password: { type: 'string', minLength: 8 },
    newPassword: { type: 'string', minLength: 8, pattern: '^[A-Za-z0-9]+$' },
    email: { type: 'string', format: 'email' },
  },
  required: ['reauthPassword'],
};

@Schema(SECRET_DTO_SCHEMA)
export class SecretDto {
  reauthPassword: string;
  password?: string;
  newPassword?: string;
  email?: string;

  constructor(data: Partial<SecretDto>) {
    Object.assign(this, data);
  }
}

export const CONFIRM_DTO_SCHEMA = {
  type: 'object',
  properties: {
    password: { type: 'string' },
    confirm: { type: 'string', const: { $data: '1/password' } },
  },
  required: ['password', 'confirm'],
};

@Schema(CONFIRM_DTO_SCHEMA)
export class ConfirmDto {
  password: string;
  confirm: string;

  constructor(data: Partial<ConfirmDto>) {
    Object.assign(this, data);
  }
}

export interface SecretCredentials {
  password: string;
}

@BasePath('secret-echo')
export class SecretEcho extends BaseController {
  @Post()
  public account(@Body() dto: SecretDto) {
    return new Ok({ ok: !!dto });
  }

  @Post()
  public confirm(@Body() dto: ConfirmDto) {
    return new Ok({ ok: !!dto });
  }

  @Post()
  public credentials(@Header('x-credentials') credentials: SecretCredentials) {
    return new Ok({ ok: !!credentials });
  }
}
