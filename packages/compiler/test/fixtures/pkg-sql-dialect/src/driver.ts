import { Injectable } from '@spinajs/di';
import { SqlDialect } from '@spinajs/orm';
import { PROFILE } from './profile.js';

@SqlDialect(PROFILE)
@Injectable('orm-driver-fixture')
export class FixtureDriver {}

@SqlDialect(PROFILE)
@Injectable('orm-driver-fixture-ssh')
export class FixtureSshDriver extends FixtureDriver {}

declare const computed: string;

@SqlDialect({ ...PROFILE, placeholders: computed as 'question' })
@Injectable('orm-driver-broken')
export class BrokenDriver {}

@SqlDialect(PROFILE)
export class UnregisteredDriver {}
