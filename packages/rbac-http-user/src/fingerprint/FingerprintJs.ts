import { Injectable } from '@spinajs/di';
import { FingerprintProvider } from '../interfaces.js';

@Injectable(FingerprintProvider)
export class FingerprintJs extends FingerprintProvider {}
