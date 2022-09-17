import { Injectable } from '@spinajs/di';
import { FingerprintProvider } from '../interfaces';

@Injectable(FingerprintProvider)
export class FingerprintJs extends FingerprintProvider {}
