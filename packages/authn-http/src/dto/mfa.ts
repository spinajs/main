import { Schema } from '@spinajs/validation';
import { bodyOf, codeField, mfaStepField } from '@spinajs/authn/schemas';

import { AuthnInput } from './base.js';

const stepField = { ...mfaStepField, description: 'one of the pending steps; default the first' } as const;

@Schema(bodyOf(['code'], { code: codeField, step: stepField }, 'authn.MfaVerifyBody'))
export class AuthnMfaVerifyBody extends AuthnInput {
  public readonly code: string;
  public readonly step?: string;
}

@Schema(bodyOf(['code'], { code: codeField }, 'authn.MfaCodeBody'))
export class AuthnMfaCodeBody extends AuthnInput {
  public readonly code: string;
}

@Schema(bodyOf(['code'], { code: codeField, step: { ...mfaStepField, description: "an enrolled step, or 'recovery'; default the first enrolled" } }, 'authn.MfaStepUpBody'))
export class AuthnMfaStepUpBody extends AuthnInput {
  public readonly code: string;
  public readonly step?: string;
}

@Schema(bodyOf([], { step: stepField }, 'authn.MfaChallengeBody'))
export class AuthnMfaChallengeBody extends AuthnInput {
  public readonly step?: string;
}
