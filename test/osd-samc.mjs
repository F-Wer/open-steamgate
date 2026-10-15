import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {parseSamc} from "../tools/osd-samc.ts";
import {parseSamc as hostParser, AmcBroker} from "../tools/osd-amc.mjs";
import {parseSamc as parentParser} from "./fixtures/samc-parser-parent.mjs";

const channel = (body) => `<AMC_CHANNEL>${body}</AMC_CHANNEL>`;
const authority = (body) => `<AMC_CHNL_AUTH>${body}</AMC_CHNL_AUTH>`;
const app = "<APPLICATION_ID> zApp </APPLICATION_ID>";
const valid = "<CHANNEL_ID> /PaTh </CHANNEL_ID><MESSAGE_TYPE_ID> text </MESSAGE_TYPE_ID>";

describe("SAMC typed boundary", () => {
  it("re-exports the same parser for the AMC host", () => {
    assert.equal(hostParser, parseSamc);
  });

  it("matches the frozen parent on every tracked SAMC object", () => {
    const files = execFileSync("git", ["ls-files", "-z"], {encoding: "utf8"})
      .split("\0").filter(file => file.toLowerCase().endsWith(".samc.xml"));
    assert.ok(files.length >= 3, "the real SAMC corpus must be present");
    for (const file of files) {
      const xml = readFileSync(file, "utf8");
      assert.deepStrictEqual(parseSamc(xml, file), parentParser(xml, file), file);
    }
  });

  it("preserves missing/empty tags, case, whitespace, duplicates, BOM and malformed XML", () => {
    const cases = [
      "", channel(valid), "<APPLICATION_ID></APPLICATION_ID>" + channel(valid),
      "<APPLICATION_ID> \n\t </APPLICATION_ID>" + channel(valid), app,
      app + channel(valid), app + channel(valid + "<SCOPE> c </SCOPE>"),
      app + channel("<CHANNEL_ID>/only</CHANNEL_ID>"),
      app + channel("<MESSAGE_TYPE_ID>TEXT</MESSAGE_TYPE_ID>"),
      app + channel("<CHANNEL_ID> </CHANNEL_ID><MESSAGE_TYPE_ID>TEXT</MESSAGE_TYPE_ID>"),
      app + channel("<CHANNEL_ID>/empty</CHANNEL_ID><MESSAGE_TYPE_ID></MESSAGE_TYPE_ID>"),
      app + channel(valid) + channel(valid),
      app + channel(valid) + authority("") + authority("<CHANNEL_ID>/other</CHANNEL_ID>"),
      "\ufeff<abapGit>" + (app + channel(valid) + authority(valid)).toLowerCase() + "</abapGit>",
      app + "<APPLICATION_ID>SECOND</APPLICATION_ID>" + channel(valid),
      app + channel(valid + "<CHANNEL_ID>/second</CHANNEL_ID>"),
      app + channel("<CHANNEL_ID>/a&amp;b</CHANNEL_ID><MESSAGE_TYPE_ID>TEXT</MESSAGE_TYPE_ID>"),
      app + "<AMC_CHANNEL attr='x'>" + valid + "</AMC_CHANNEL>",
      app + "<AMC_CHANNEL>" + valid,
      app + channel("<CHANNEL_ID><nested/></CHANNEL_ID><MESSAGE_TYPE_ID>TEXT</MESSAGE_TYPE_ID>"),
      app + channel("<CHANNEL_ID>/Ünicode</CHANNEL_ID><MESSAGE_TYPE_ID>text</MESSAGE_TYPE_ID>"),
    ];
    for (const [i, xml] of cases.entries()) {
      for (const source of [undefined, "", "relative/source.samc.xml"]) {
        assert.deepStrictEqual(parseSamc(xml, source), parentParser(xml, source), `case ${i}`);
      }
    }
  });

  it("keeps own undefined fields and one shared, unfiltered authority array", () => {
    const xml = app + channel(valid) + channel(valid)
      + authority("") + authority("<CHANNEL_ID>/other</CHANNEL_ID><ACTIVITY> S </ACTIVITY>");
    const rows = parseSamc(xml);
    assert.deepStrictEqual(rows, parentParser(xml));
    assert.deepStrictEqual(Object.keys(rows[0]), ["applicationId", "path", "type", "scope", "authorities", "source"]);
    assert.equal(Object.hasOwn(rows[0], "scope"), true);
    assert.equal(Object.hasOwn(rows[0], "source"), true);
    assert.equal(rows[0].scope, undefined);
    assert.equal(rows[0].source, undefined);
    assert.equal(rows[0].authorities, rows[1].authorities);
    assert.deepStrictEqual(rows[0].authorities[0], {path: undefined, program: undefined, activity: undefined});
    assert.equal(rows[0].authorities.length, 2);
  });

  it("leaves exact authority filtering to the broker", () => {
    const xml = app + channel(valid)
      + authority("<CHANNEL_ID>/path</CHANNEL_ID><PROGRAM_ID> prog </PROGRAM_ID><ACTIVITY>S</ACTIVITY>")
      + authority("<CHANNEL_ID>/other</CHANNEL_ID><PROGRAM_ID>prog</PROGRAM_ID><ACTIVITY>R</ACTIVITY>")
      + authority("<CHANNEL_ID>/path</CHANNEL_ID><PROGRAM_ID>prog</PROGRAM_ID><ACTIVITY>s</ACTIVITY>");
    for (const parser of [parentParser, parseSamc]) {
      const broker = new AmcBroker(parser(xml));
      assert.equal(broker.channel("zapp", "/PATH", "S", "prog").path, "/path");
      assert.throws(() => broker.channel("zapp", "/path", "R", "prog"), /not authorised/);
      assert.throws(() => broker.channel("zapp", "/path", "S", "other"), /not authorised/);
    }
  });
});
