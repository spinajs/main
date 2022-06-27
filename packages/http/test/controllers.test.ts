import { SamplePolicy } from './policies/SamplePolicy';
import { SampleMiddleware } from './middlewares/SampleMiddleware';
import 'mocha';

import { expect } from 'chai';
import { join, normalize, resolve } from 'path';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";
import chai from 'chai';
import chaiHttp from 'chai-http';
import { SpinaJsDefaultLog, LogModule } from '@spinajs/log';
import { Controllers, HttpServer } from '../src';
import { Intl } from "@spinajs/intl";
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { SampleMiddleware2 } from './middlewares/SampleMiddleware2';
import { SamplePolicy2 } from './policies/SamplePolicy2';
import { Test } from './controllers/Test';
import * as fs from "fs";

chai.use(chaiHttp);
chai.use(chaiAsPromised);


function req() {
    return chai.request("http://localhost:8888/");
}

class TestConfiguration extends FrameworkConfiguration {
    protected CONFIG_DIRS: string[] = [
        // project path
        "/test/config",
    ];
}

function ctr() {
    return DI.get(Controllers);
}



describe("http & controller tests", function () {

    this.timeout(15000);

    before(async () => {

        DI.register(TestConfiguration).as(Configuration);
        DI.register(SpinaJsDefaultLog).as(LogModule);

        await DI.resolve(LogModule);
        await DI.resolve(Intl);
        await DI.resolve<Controllers>(Controllers);
        const server = await DI.resolve<HttpServer>(HttpServer);

        server.start();


    });

    after(async () => {

        const server = await DI.resolve<HttpServer>(HttpServer);
        server.stop();

    });

    afterEach(() => {
        sinon.restore();
    });

    it("should load controllers from dir", async () => {
        const controllers = await ctr().Controllers;
        expect(controllers.length).to.eq(7);
    });

    it("should server static files", async () => {
        const response = await req().get("static/index.html");
        expect(response).to.have.status(200);
    });

    it("non existing static file should return 404", async () => {
        const response = await req().get("static/non-exists.html");
        expect(response).to.have.status(404);
    });

    it("should add routes", async () => {
        let response = await req().get("test2/testGet");
        expect(response).to.have.status(200);

        response = await req().post("test2/testPost");
        expect(response).to.have.status(200);

        response = await req().head("test2/testHead");
        expect(response).to.have.status(200);

        response = await req().patch("test2/testPatch");
        expect(response).to.have.status(200);

        response = await req().del("test2/testDel");
        expect(response).to.have.status(200);

        response = await req().put("test2/testPut");
        expect(response).to.have.status(200);
    });

    it("should add routes with base path", async () => {
        let response = await req().get("sample-controller/v1/testGet");
        expect(response).to.have.status(200);

        response = await req().post("sample-controller/v1/testPost");
        expect(response).to.have.status(200);

        response = await req().head("sample-controller/v1/testHead");
        expect(response).to.have.status(200);

        response = await req().patch("sample-controller/v1/testPatch");
        expect(response).to.have.status(200);

        response = await req().del("sample-controller/v1/testDel");
        expect(response).to.have.status(200);

        response = await req().put("sample-controller/v1/testPut");
        expect(response).to.have.status(200);
    });

    it("middleware should run on controller", async () => {

        const onBeforeSpy = sinon.spy(SampleMiddleware.prototype, "onBeforeAction");
        const onAfterSpy = sinon.spy(SampleMiddleware.prototype, "onAfterAction");


        const response = await req().get("testmiddleware/testGet");
        expect(response).to.have.status(200);

        expect(onBeforeSpy.called).to.be.true;
        expect(onAfterSpy.called).to.be.true;
    });

    it("middleware should run on specific path", async () => {


        let response = await req().get("testmiddlewarepath/testGet2");
        expect(response).to.have.status(200);
        expect(SampleMiddleware2.CalledAfter).to.be.false;
        expect(SampleMiddleware2.CalledBefore).to.be.false;

        response = await req().get("testmiddlewarepath/testGet");
        expect(response).to.have.status(200);

        expect(SampleMiddleware2.CalledAfter).to.be.true;
        expect(SampleMiddleware2.CalledBefore).to.be.true;

    });

    it("policy should run on controller", async () => {
        const response = await req().get("testpolicy/testGet");
        expect(response).to.have.status(200);
        expect(SamplePolicy.Called).to.be.true;
    });

    it("policy should run on specific path", async () => {

        let response = await req().get("testpolicy2/testGet2");
        expect(response).to.have.status(200);
        expect(SamplePolicy2.Called).to.be.false;

        response = await req().get("testpolicy2/testGet");
        expect(response).to.have.status(403);

        expect(SamplePolicy2.Called).to.be.true;
    });

    it("html response should work", async () => {
        const response = await req().get("sample-controller/v1/testGet").set("Accept", "text/html").send();
        expect(response).to.have.status(200);
        expect(response).to.be.html;
        expect(response.text).to.eq('<html><head><link rel="icon" type="image/x-icon" href="/static/favicon.png"/><title> All ok</title><link href="/static/style.css" rel="stylesheet"/></head><body>   <div class="container"><div class="item"><div class="entry"><h1>200 - All ok</h1></div></div></div></body></html>');
    });

    it("json response should work", async () => {
        const response = await req().get("sample-controller/v1/testGet").set("Accept", "application/json").send();
        expect(response).to.have.status(200);
        expect(response).to.be.json;
        expect(response.body).to.be.not.null;
        expect(response.body).to.include({
            hello: "world"
        });
    });

    it("Should validate schema for simple DTO", async () => {
        expect(false).to.be.true;
    });

    it("Cvs file response should work", async () => {
        expect(false).to.be.true;
    });

    it("Json file response should work", async () => {
        expect(false).to.be.true;
    });

    it("Should accept data from csv file", async () => {
        expect(false).to.be.true;
    });

    it("Should accept data from json file", async () => {
        expect(false).to.be.true;
    });

    it("Should validate schema for form", async () => {
        expect(false).to.be.true;
    });

    it("Should accept multiple files", async () => {
        expect(false).to.be.true;
    });

    it("Should allow to configure upload dir for incoming files", async () => {
        expect(false).to.be.true;
    });

    it("Should get param from request header", async () => {
        expect(false).to.be.true;
    });

    it("Should hydrate custom class object", async () => {
        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testDataHydration");

        const response = await req().post("sample-controller/v1/testDataHydration").send({ Id: 1234});
        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.include({
            Id: "1234"
        });
        expect(testFunc.args[0][0].constructor.name).to.eq("TestHydrator");
    });

    it("Should pass luxor DateTime object", async () => {

        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testLuxorDateTime");

        const response = await req().post("sample-controller/v1/testLuxorDateTime").send({ date: new Date()});
        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0].constructor.name).to.eq("DateTime");

    });

    it("plain response should work", async () => {
        const response = await req().get("sample-controller/v1/testGet").set("Accept", "text/plain").send();
        expect(response).to.have.status(200);
        expect(response).to.be.text;
        expect(response.text).to.eq('{"hello":"world"}');
    });


    it("error handling should work", async () => {
        const response = await req().get("sample-controller/v1/testError");
        expect(response).to.have.status(500);
        expect(response.text).to.eq('<html><head><link rel="icon" type="image/x-icon" href="/static/favicon.ico"/><title> Server error</title><link href="/static/style.css" rel="stylesheet"/></head><body>   <div class="container"><div class="item"><div class="entry"><h1>500 - Server error</h1><div>sample error message</div></div></div></div></body></html>');
    });

    it("controller view should work", async () => {
        const response = await req().get("sample-controller/v1/testViewResponse");
        expect(response).to.have.status(200);
        expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>hello world</p></body></html>');
    });

    it("intl in view should work", async () => {
        let response = await req().get("sample-controller/v1/testViewIntl").query({ lang: "pl" });
        expect(response).to.have.status(200);
        expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>witaj świecie</p></body></html>');

        response = await req().get("sample-controller/v1/testViewIntl").query({ lang: "en" });
        expect(response).to.have.status(200);
        expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>hello world</p></body></html>');

        response = await req().get("sample-controller/v1/testViewIntl");
        expect(response).to.have.status(200);
        expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>witaj świecie</p></body></html>');
    });

    it("should pass query params", async () => {

        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testQueryParam");


        const response = await req().get("sample-controller/v1/testQueryParam").query({ first: "pl", second: 1234, bool: true, int: { id: 1 }, object: {id : 2} });
        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.eq("pl");
        expect(testFunc.args[0][1]).to.eq(1234);
        expect(testFunc.args[0][2]).to.eq(true);
        expect(testFunc.args[0][3]).to.include({
            id: '1' // object passed as query params have allways props as strings
        });
        expect(testFunc.args[0][4]).to.include({
            id: '2'
        });
        expect(testFunc.args[0][4].constructor.name).to.eq("TestParamClass");


    });

    it("should pass post data as object", async () => {

        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testPostParamSingle");

        const response = await req().post("sample-controller/v1/testPostParamSingle").send({ id: 1 });
        expect(response).to.have.status(200);
        expect(testFunc.args[0][0]).to.include({
            id: 1
        });
        expect(testFunc.args[0][0].constructor.name).to.eq("TestParamClass");
    });

    it("should pass post params as args", async () => {
        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testPostParam");

        const response = await req().post("sample-controller/v1/testPostParam").send({ first: "pl", second: 1234, bool: true, int: { id: 1 }, object: { id: 2 } });
        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.eq("pl");
        expect(testFunc.args[0][1]).to.eq(1234);
        expect(testFunc.args[0][2]).to.eq(true);
        expect(testFunc.args[0][3]).to.include({
            id: 1
        });
        expect(testFunc.args[0][4]).to.include({
            id: 2
        });
        expect(testFunc.args[0][4].constructor.name).to.eq("TestParamClass");

    });

    it("should pass query param", async () => {
        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testParams");

        const response = await req().get("sample-controller/v1/testParams/testString/12345/true/" + JSON.stringify({ id: 1 }) + "/" + JSON.stringify({ id: 1 }))
        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.eq("testString");
        expect(testFunc.args[0][1]).to.eq(12345);
        expect(testFunc.args[0][2]).to.eq(true);
        expect(testFunc.args[0][3]).to.include({
            id: 1
        });
        expect(testFunc.args[0][4]).to.include({
            id: 1
        });
        expect(testFunc.args[0][4].constructor.name).to.eq("TestParamClass");
    });

    it("should pass form params", async () => {
        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testForm");

        const response = await req().post("sample-controller/v1/testForm")
            .field("hello", "world")
            .field("foo", "bar");

        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.include({
            hello: "world",
            foo: "bar"
        });

    });

    it("should pass file params", async () => {

        const testController = await DI.resolve(Test);
        const testFunc = sinon.spy(testController, "testMultipartForm");

        const response = await req().post("sample-controller/v1/testMultipartForm").attach('_index', fs.readFileSync(normalize(join(resolve(__dirname), "./public/index.html"))), 'index.html')
            .field("hello", "world")
            .field("foo", "bar");

        expect(response).to.have.status(200);
        expect(testFunc.calledOnce).to.be.true;
        expect(testFunc.args[0][0]).to.include({
            hello: "world",
            foo: "bar"
        });

        expect(testFunc.args[0][1].Name).to.eq("index.html");
    });

    it("should response with file", async () => {
        const response = await req().get("sample-controller/v1/testFileResponse");
        expect(response).to.have.status(200);
        expect(response.text).to.eq("<html>\r\n    <body>\r\n        <h1>Test</h1>\r\n    </body>\r\n</html>");
    });

    it("should validate params schema simple", async () => {
        let response = await req().get("sample-controller/v1/testValidation").query({ id: 1 });
        expect(response).to.have.status(200);

        response = await req().get("sample-controller/v1/testValidation").query({ id: "sss" });
        expect(response).to.have.status(400);
    });

    it("should validate body", async () => {
        let response = await req().post("sample-controller/v1/testValidation2").send({ id: 1 });
        expect(response).to.have.status(200);

        response = await req().post("sample-controller/v1/testValidation2").send({ id: "ddd" });
        expect(response).to.have.status(400);
    });

    it("should inject service as parameter", async () => {

        const testController = await DI.resolve(Test);
        const testInjectSpy = sinon.spy(testController, "testInject");
        const response = await req().get("sample-controller/v1/testInject");

        expect(testInjectSpy.calledOnce);
        expect(testInjectSpy.args[0][0].constructor.name).to.eq("SomeService");


        expect(response).to.have.status(200);
    });
});
