import "mocha";
import { expect } from "chai";

import { loggableEndpoint, loggableExportError } from "../src/loggable-endpoint.js";

describe("loggableEndpoint", () => {
  it("keeps the scheme, the host, the port and the path", () => {
    expect(loggableEndpoint("https://otel.highlight.io:4318/v1/traces")).to.eq("https://otel.highlight.io:4318/v1/traces");
    expect(loggableEndpoint("http://collector/otlp/v1/metrics")).to.eq("http://collector/otlp/v1/metrics");
  });

  it("leaves out the userinfo", () => {
    expect(loggableEndpoint("https://user:planted-secret@collector:4318/v1/traces")).to.eq("https://collector:4318/v1/traces");
    expect(loggableEndpoint("https://planted-secret@collector/v1/traces")).to.eq("https://collector/v1/traces");
  });

  it("leaves out the query and the fragment", () => {
    expect(loggableEndpoint("https://collector/v1/traces?token=planted-token&api_key=planted-key#planted-fragment")).to.eq("https://collector/v1/traces");
  });

  it("prints a placeholder, never the text, for a value that does not parse", () => {
    expect(loggableEndpoint("http://user:planted-secret@collector:99999/v1/traces")).to.eq("<not a URL>");
    expect(loggableEndpoint("planted-secret")).to.eq("<not a URL>");
    expect(loggableEndpoint("")).to.eq("<not a URL>");
  });

  it("keeps an IPv6 host in brackets", () => {
    expect(loggableEndpoint("http://user:planted-secret@[::1]:4318/v1/traces?token=planted-token")).to.eq("http://[::1]:4318/v1/traces");
  });

  it("masks a path segment that may be a token", () => {
    expect(loggableEndpoint("https://collector/ingest/0f8c2a4be1d94c3e9a7b5d6e8f901234/v1/traces")).to.eq("https://collector/ingest/***/v1/traces");
    expect(loggableEndpoint("https://collector/sk_live_plantedsecretvalue/v1/traces")).to.eq("https://collector/***/v1/traces");
    expect(loggableEndpoint("https://collector/key%3Dplanted/v1/traces")).to.eq("https://collector/***/v1/traces");
  });

  it("masks the opaque part of a URL that has no host", () => {
    expect(loggableEndpoint("mailto:planted-secret@collector")).to.eq("mailto://***");
    expect(loggableEndpoint("apikey:PLSHORT")).to.eq("apikey://***");
    expect(loggableEndpoint("data:PLDATASHORT")).to.eq("data://***");
  });
});

describe("loggableExportError", () => {
  const endpoint = "http://user:planted-secret@collector:4318/ingest/sk_live_plantedsecretvalue?token=planted-token";

  it("keeps the name, the code and the status, and nothing else of the error", () => {
    const error = Object.assign(new Error("Request failed with status code 401"), { code: "ERR_BAD_REQUEST", response: { status: 401 }, config: { baseURL: endpoint } });
    expect(loggableExportError(error, endpoint)).to.deep.eq({ name: "Error", message: "Request failed with status code 401", code: "ERR_BAD_REQUEST", status: 401 });
  });

  it("prints the endpoint redacted where the message repeats it", () => {
    const error = new TypeError(`cannot post to ${endpoint}: secret planted-secret, token planted-token`);
    expect(loggableExportError(error, endpoint).message).to.eq("cannot post to http://collector:4318/ingest/***: secret ***, token ***");
  });

  it("prints the endpoint as a placeholder where it does not parse", () => {
    const unparsable = "http://user:planted-secret@collector:99999/v1/logs";
    expect(loggableExportError(new Error(`Invalid URL ${unparsable}`), unparsable).message).to.eq("Invalid URL <not a URL>");
  });

  it("describes a rejection that is not an error", () => {
    expect(loggableExportError({ response: { status: 503 } }, endpoint)).to.deep.eq({ name: "Error", message: "[object Object]", status: 503 });
  });
});
