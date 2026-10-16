import "mocha";
import { expect } from "chai";
import { renderTemplate, renderValue } from "../src/index.js";

describe("renderTemplate", () => {
  it("fills ${name} from the fields and keeps a conditional body only when its field is set", () => {
    const t = "op ${op}${?who} who=${who}${/who}${?why} why=${why}${/why}";
    expect(renderTemplate(t, { op: "login", who: "u-1" })).to.equal("op login who=u-1");
    expect(renderTemplate(t, { op: "login", who: null, why: "" })).to.equal("op login");
  });

  it("renders a name the call does not pass as absent, whatever the ambient context holds", () => {
    expect(renderTemplate("a${?ip} ip=${ip}${/ip} b=${b}", {})).to.equal("a b=");
  });

  it("leaves ${name:option} to the target layout", () => {
    expect(renderTemplate("at ${time:HH:mm}", { time: "x" })).to.equal("at ${time:HH:mm}");
  });

  it("quotes and escapes a value so it cannot forge a field, a line or a placeholder", () => {
    expect(renderTemplate("r=${r}", { r: "a b" })).to.equal('r="a b"');
    expect(renderTemplate("r=${r}", { r: "x\nk=v" })).to.equal('r="x\\nk=v"');
    expect(renderTemplate("r=${r}", { r: "${level}" })).to.equal('r="\\u0024{level}"');
    expect(renderTemplate("r=${r}", { r: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c` })).to.equal('r="a\\u2028b\\u202ec"');
  });

  it("doubles % in values only when printf args follow", () => {
    expect(renderTemplate("r=${r} %s", { r: "%s x" }, true)).to.equal('r="%%s x" %s');
    expect(renderTemplate("r=${r}", { r: "%s x" })).to.equal('r="%s x"');
  });
});

describe("renderValue", () => {
  it("writes a plain token as it is", () => {
    expect(renderValue("user:u-42")).to.equal("user:u-42");
    expect(renderValue(42)).to.equal("42");
  });

  it("writes a valid Date as ISO time and an invalid one quoted", () => {
    expect(renderValue(new Date("2026-10-03T10:00:00.000Z"))).to.equal("2026-10-03T10:00:00.000Z");
    expect(renderValue(new Date(Number.NaN))).to.equal('"Invalid Date"');
  });

  it("writes an object as quoted JSON", () => {
    expect(renderValue({ a: 1 })).to.equal('"{\\"a\\":1}"');
  });
});
