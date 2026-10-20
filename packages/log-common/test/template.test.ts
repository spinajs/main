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

  it("writes an object or array as escaped JSON and an Error as its message", () => {
    expect(renderValue({ a: "x y", b: [1] })).to.equal('{"a":"x y","b":[1]}');
    expect(renderValue({ a: "${level}" })).to.equal('{"a":"\\u0024{level}"}');
    expect(renderValue(new Error("not found"))).to.equal('"not found"');
  });

  it("writes an object whose toJSON gives a string as that string", () => {
    expect(renderValue({ toJSON: () => "2026-10-03T10:00:00.000+02:00" })).to.equal("2026-10-03T10:00:00.000+02:00");
  });

  it("writes Windows paths, non-ASCII letters and emails as plain tokens", () => {
    expect(renderValue("C:\\logs\\app.log")).to.equal("C:\\logs\\app.log");
    expect(renderValue("Zażółć")).to.equal("Zażółć");
    expect(renderValue("a@b.pl")).to.equal("a@b.pl");
  });
});

describe("renderTemplate tag matching", () => {
  const fields = { a: 1, b: "B" };

  it("closes a conditional at the first matching close tag and leaves stray tags as text", () => {
    expect(renderTemplate("${?a}1${/a}2${/a}", fields)).to.equal("12${/a}");
    expect(renderTemplate("${?a}${?a}x${/a}", fields)).to.equal("${?a}x");
    expect(renderTemplate("<${?a}x${?b}y${/a}z${/b}>", fields)).to.equal("<x${?b}yz${/b}>");
    expect(renderTemplate("${?c}x${/a}${?a}y${/c}${/a}", fields)).to.equal("${/a}");
    expect(renderTemplate("${?x} ${/x} ${b}", fields)).to.equal(" B");
    expect(renderTemplate("${/a} ${?b}", fields)).to.equal("${/a} ${?b}");
  });

  it("takes a placeholder name up to the first } and skips one that runs into a :", () => {
    expect(renderTemplate("${${a}", fields)).to.equal("");
    expect(renderTemplate("${a ${b}", fields)).to.equal("");
    expect(renderTemplate("${a:x ${b}", fields)).to.equal("${a:x B");
  });

  it("renders unclosed tags in linear time", () => {
    const started = performance.now();
    expect(renderTemplate("${?a}" + "${?a}x".repeat(30_000), {})).to.have.length(180_005);
    expect(renderTemplate("${b".repeat(40_000) + ":}", fields)).to.equal("${b".repeat(40_000) + ":}");
    expect(performance.now() - started).to.be.below(500);
  });
});
