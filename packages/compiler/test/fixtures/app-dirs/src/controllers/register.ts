import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { SideEffectController } from '../elsewhere/SideEffectController.js';

DI.register(SideEffectController).as(BaseController);
