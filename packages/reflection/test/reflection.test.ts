import { ReflectionException } from './../src/index';
import { FrameworkConfiguration, Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as chaiSubset from 'chai-subset';
import _ = require('lodash');
import 'mocha';
import { join, normalize, resolve } from 'path';
import { ResolveFromFiles, ListFromFiles } from '../src';
import { FooService } from './test-services/singletons/FooService';
import { SpinaJsDefaultLog, LogModule } from '@spinajs/log';
import { SomeMatcher1TestClass } from './test-services/matcher/SomeMatcher1';

export function dir(path: string) {
    return resolve(normalize(join(__dirname, path)));
}

const expect = chai.expect;
chai.use(chaiAsPromised);
chai.use(chaiSubset);

export class MockCfg extends FrameworkConfiguration {

    private conf = {
        system: {
            dirs: {
                singletons: [dir("./test-services/singletons")],
                alwaysnew: [dir("./test-services/alwaysnew")],
                async: [dir("./test-services/async")],
                throw: [dir("./test-services/throw")],
                mixed: [dir("./test-services/mixed")],
                throwasync: [dir("./test-services/throwasync")],
                empty: [dir("./test-services/empty")],
                matcher: [dir("./test-services/matcher")],

            }
        },

    }

    public get(path: string[], defaultValue?: any): any {
        return _.get(this.conf, path, defaultValue);
    }
}

describe("Reflection tests", () => {
    beforeEach(() => {
        DI.clear();
        DI.register(MockCfg).as(Configuration);
        DI.register(SpinaJsDefaultLog).as(LogModule);


        FooService.Counter = 0;
    })

    it("Should load services", async () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.singletons")(target, "services");

        await target.services;

        expect(target.services).to.be.not.null;
        expect(target.services).to.be.an("array").that.have.length(2);
        expect(target.services[0]).to.include({
            name: "FooService"
        }).and.to.have.property("instance").not.null;
    })

    it("Should load services with type matcher", () =>{ 
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.matcher", (name) => {
            return `${name}TestClass`;
        })(target, "services");

        const services = target.services;
        const cache = DI.RootContainer.Cache as any;

        expect(services).to.be.an("array").that.have.length(1);
        expect(cache).to.be.an("Map");
        expect(cache.get("SomeMatcher1TestClass")).to.not.null;

        
        expect(DI.resolve(SomeMatcher1TestClass)).to.be.not.null;
    })

    it("Should load services as singletons default", () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.singletons")(target, "services");

        const services = target.services;
        const cache = DI.RootContainer.Cache as any;

        expect(services).to.be.an("array").that.have.length(2);
        expect(cache).to.be.an("Map");
        expect(cache.get("FooService")).to.not.null;
        expect(cache.get("FooService2")).to.not.null;

        expect(DI.resolve(FooService)).to.be.not.null;
        expect(FooService.Counter).to.eq(1);

        console.log(services);
    })

    it("Should load service async", async () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.async")(target, "services");

        expect((target.services as any).then).to.be.instanceOf(Function);
        expect(target.services).to.be.fulfilled.and.eventually.be.an("array");

        const servs = await target.services;
        expect(servs[0].name).to.eq("FooService");
        expect(servs[0].instance.Counter).to.eq(1);
    })

    it("Should load mixed sync and async as async", async () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.mixed")(target, "services");

        expect((target.services as any).then).to.be.instanceOf(Function);
        expect(target.services).to.be.fulfilled.and.eventually.be.an("array");


        const servs = await target.services;
        expect(servs[0].name).to.eq("FooService");
    })

    it("Should throw when class not found", () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.throw")(target, "services");

        expect(() => {
            // tslint:disable-next-line: no-unused-expression-chai
            target.services;
        }).to.throw(ReflectionException);
    })

    it("Should reject on async class not found", () => {
        const target = {
            services: [] as any[]
        };

        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.mixed")(target, "services");

        expect((target.services as any).then).to.be.instanceOf(Function);
        expect(target.services).to.be.rejected;

    })


    it("Should load service as new always", () => {

        const target = {
            services: [] as any[]
        };

        const target2 = {
            services: [] as any[]
        };


        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.alwaysnew")(target, "services");
        ResolveFromFiles("/**/*.{ts,js}", "system.dirs.alwaysnew")(target2, "services");

        expect(target.services[0].instance.Counter).to.eq(1);
        expect(target2.services[0].instance.Counter).to.eq(1);

        expect(DI.RootContainer.Cache).to.be.an("Map");
        expect(DI.RootContainer.Cache.get("FooService")).to.be.not.null;
    })

    it("Should list class from files", () => {

        const target = {
            services: [] as any[]
        };


        ListFromFiles("/**/*.{ts,js}", "system.dirs.alwaysnew")(target, "services");

        expect(target.services).to.be.an("array");
        expect(target.services[0].name).to.eq("FooService");
        expect(target.services[0].instance).to.be.null;

    })

    it("should load empty array if args missing", ()=>{
        const target = {
            services: null as any[]
        };

        ListFromFiles("/**/*.{ts,js}", "fake.config.parameter")(target, "services");
        expect(target.services).to.be.an("array").with.length(0);
    })

    it("should load empty array if directory is empty", ()=>{
        const target = {
            services: null as any[]
        };

        ListFromFiles("/**/*.{ts,js}", "system.dirs.empty")(target, "services");
        expect(target.services).to.be.an("array").with.length(0);
    })
});