var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { ClassInfo, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { isProduction } from '@spinajs/authz';
import { CONTROLLED_DESCRIPTOR_SYMBOL, ControllerSource } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { ExplainController } from './controller.js';
/**
 * Hands the explain route to http only while `authz.http.explainRoute.enabled` and outside
 * production, so in production it is never registered and a request gets 404 (H19, B41).
 */
let ExplainControllerSource = class ExplainControllerSource extends ControllerSource {
    async getControllers() {
        // The schema is the gate; this holds for a value that never went through it ('false', 1).
        if (this.ExplainEnabled !== true)
            return [];
        if (isProduction(this.IsProduction)) {
            this.Log.warn('authz.http.explainRoute.enabled is true in production; the explain route is not registered');
            return [];
        }
        const ci = new ClassInfo();
        ci.name = ExplainController.name;
        ci.type = ExplainController;
        ci.file = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, ExplainController.prototype)?.SourceFile ?? '<di>';
        return [ci];
    }
};
__decorate([
    Logger('authz-http'),
    __metadata("design:type", Log)
], ExplainControllerSource.prototype, "Log", void 0);
__decorate([
    Config('authz.http.explainRoute.enabled'),
    __metadata("design:type", Boolean)
], ExplainControllerSource.prototype, "ExplainEnabled", void 0);
__decorate([
    Config('configuration.isProduction'),
    __metadata("design:type", Object)
], ExplainControllerSource.prototype, "IsProduction", void 0);
ExplainControllerSource = __decorate([
    Injectable(ControllerSource)
], ExplainControllerSource);
export { ExplainControllerSource };
//# sourceMappingURL=source.js.map