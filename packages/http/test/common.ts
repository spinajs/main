
import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from "@spinajs/configuration";
import chai from 'chai';
import { Controllers } from '../src';

export function req() {
    return chai.request("http://localhost:8888/");
}

export class TestConfiguration extends FrameworkConfiguration {
    protected CONFIG_DIRS: string[] = [
        // project path
        "/test/config",
    ];
}

export function ctr() {
    return DI.get(Controllers);
}
