var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';
import { Configuration } from '@spinajs/configuration-common';
import { Autoinject } from '@spinajs/di';
let DumpConfiguration = class DumpConfiguration extends CliCommand {
    async execute(options) {
        this.Log.info(JSON.stringify(!options.path ? this.Config.RootConfig : this.Config.get(options.path), null, 4));
    }
};
__decorate([
    Logger('cli'),
    __metadata("design:type", Log)
], DumpConfiguration.prototype, "Log", void 0);
__decorate([
    Autoinject(),
    __metadata("design:type", Configuration)
], DumpConfiguration.prototype, "Config", void 0);
DumpConfiguration = __decorate([
    Command('configuration:dump', 'Dumps configuration'),
    Option('-p, --path <path>', false, 'configuration path')
], DumpConfiguration);
export { DumpConfiguration };
//# sourceMappingURL=DumpConfig.js.map