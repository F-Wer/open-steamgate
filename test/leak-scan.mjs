import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

describe("leak scanner", () => {
  const folder = mkdtempSync(join(tmpdir(), "osd-leak-vector-"));
  const packedPrivateAddress = [
    "00112233445566778899aabb", "c0", "a8", "01", "2a", "ffeeddbbccaa9988",
  ].join("");
  const privateAddress = [192, 168, 1, 42].join(".");
  const scan = (file) => spawnSync(process.execPath,
    ["tools/osd-leak-scan.mjs", ".", "--paths", file], {encoding: "utf8"});

  after(() => rmSync(folder, {recursive: true, force: true}));

  it("treats only declared embedding vector fields as opaque bytes", () => {
    const fixture = join(folder, "packs", "zvdb", "fixtures");
    mkdirSync(fixture, {recursive: true});
    const file = join(fixture, "corpus.test.json");
    writeFileSync(file, JSON.stringify({vectorHex: packedPrivateAddress, qbits: packedPrivateAddress}));
    const result = scan(file);
    assert.ok([0, 2].includes(result.status), result.stderr);
  });

  it("still decodes the same bytes in an ordinary field", () => {
    const file = join(folder, "ordinary.json");
    writeFileSync(file, JSON.stringify({payloadHex: packedPrivateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  it("still scans ordinary text beside an opaque vector", () => {
    const fixture = join(folder, "packs", "zvdb", "fixtures");
    mkdirSync(fixture, {recursive: true});
    const file = join(fixture, "corpus.mixed.json");
    writeFileSync(file, JSON.stringify({qbits: packedPrivateAddress, host: privateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /частный адрес \(текст\): 192\.168\.1\.42/);
  });

  it("does not trust JSON-looking vector fields in an ordinary text file", () => {
    const file = join(folder, "vector-looking.txt");
    writeFileSync(file, JSON.stringify({qbits: packedPrivateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  // A SHA-256 digest packing a private prefix by chance, padded to 64 hex
  // (its halves do not read as UUIDs: no version nibble at 12, no variant at 16).
  const digest = "aaaaaaaaaaaa0aaa0a" + "c0a8012a" + "aaaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
  // Two session GUIDs back to back, privateAddress packed in both node fields.
  const guid = (n) => `00112233445546778899c0a8012a000${n}`;
  const guids = guid(1) + guid(2);
  // A 32-byte IPv4/UDP packet whose source address is privateAddress.
  const packet = "4500002000004000401100" + "00" + "c0a8012a" + "c0a80101" + "1f9000350008" + "0000" + "deadbeef";
  const digestFile = (name, body) => { const file = join(folder, name); writeFileSync(file, body); return file; };

  it("does not decode a 64-hex SHA-256 digest in its canonical spellings as packed addresses", () => {
    assert.equal(digest.length, 64);
    for (const [name, body] of [["sha.txt", `sha256:${digest}\n`], ["sri.txt", `integrity sha256-${digest}\n`],
      ["shape.abap", `* TS: shape.${digest}\n`], ["oci.json", JSON.stringify({digest: `sha256:${digest}`})]]) {
      const result = scan(digestFile(name, body));
      assert.ok([0, 2].includes(result.status), `${name}: ${result.stderr}`);
    }
  });

  it("still decodes generic labels, other lengths, GUIDs and captures as packed addresses", () => {
    assert.equal(guid(1).length, 32);
    assert.equal(packet.length, 64);
    for (const [name, body] of [["bare.txt", `value ${digest}\n`], ["hash.txt", `hash:${digest}\n`],
      ["digest-key.json", JSON.stringify({digest})], ["rehash.txt", `rehash:${digest}\n`],
      ["long.txt", `sha256:${digest}a\n`], ["short.txt", `sha256:${digest.slice(0, 63)}\n`],
      ["guid.txt", `session ${guid(1)}\n`], ["guid-after-marker.txt", `sha256:${guid(1)}\n`],
      ["guids-after-hash.txt", `hash:${guids}\n`], ["guids-after-sha.txt", `sha256:${guids}\n`],
      ["packet-digest.json", JSON.stringify({digest: packet})]]) {
      const result = scan(digestFile(name, body));
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /192\.168\.1\.42/, name);
    }
  });

  it("exempts a digest with a UUID-looking half and decodes only that half's node field", () => {
    // version nibble 4 and variant 8 in the first half, the packed prefix outside its node field
    const uuidish = "c0a8012a" + "aaaa" + "4aaa" + "8aaa" + "aaaaaaaaaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
    assert.equal(uuidish.length, 64);
    let result = scan(digestFile("uuidish.abap", `* TS: shape.${uuidish}\n`));
    assert.ok([0, 2].includes(result.status), result.stderr);
    // the same prefix in that half's node field is still a GUID-carried address
    const node = "aaaaaaaa" + "aaaa" + "4aaa" + "8aaa" + "c0a8012aaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
    result = scan(digestFile("uuid-node.abap", `* TS: shape.${node}\n`));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
    // and in the second half's node field
    const second = "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb" + "aaaaaaaa" + "aaaa" + "1aaa" + "9aaa" + "c0a8012aaaaa";
    result = scan(digestFile("uuid-node-2.abap", `sha256:${second}\n`));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  it("treats a bare 64-hex value as a digest only when the same scan saw it after a marker", () => {
    const marked = digestFile("shape-class.abap", `* TS: shape.${digest}\n`);
    const bare = digestFile("descriptor.abap", `CREATE OBJECT x EXPORTING name = \`${digest.toUpperCase()}\`.\n`);
    let result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", marked, bare], {encoding: "utf8"});
    assert.ok([0, 2].includes(result.status), result.stderr);
    // the order of the files does not matter: the marked one may come last
    result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", bare, marked], {encoding: "utf8"});
    assert.ok([0, 2].includes(result.status), result.stderr);
    result = scan(bare);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
    // a different bare value beside a marked digest is still decoded
    const other = digest.replace(/^a/, "b");
    const otherFile = digestFile("other.abap", `name = \`${other}\`\n`);
    result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", marked, otherFile], {encoding: "utf8"});
    assert.equal(result.status, 1, result.stderr);
  });

  it("still finds a dotted address and decoded text beside an exempt digest", () => {
    let result = scan(digestFile("mixed-digest.txt", `sha256:${digest} host ${privateAddress}\n`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /частный адрес \(текст\): 192\.168\.1\.42/);
    // the hex→ascii text view of the run itself is still matched for dotted addresses
    const dotted = Buffer.from(` ${privateAddress} `.padEnd(32, " ")).toString("hex");
    result = scan(digestFile("dotted-in-digest.txt", `sha256:${dotted}\n`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hex→ascii\): 192\.168\.1\.42/);
  });

  describe("redacted output for a public log", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-leak-redact-"));
    const category = "zz secret category";
    const name = "zzleakprobename";
    mkdirSync(join(root, ".local"), {recursive: true});
    writeFileSync(join(root, ".local", "leak-identifiers.json"), JSON.stringify({[category]: [name]}));
    const file = join(root, "draft.txt");
    writeFileSync(file, `text mentioning ${name.toUpperCase()} here\n`);
    const run = (...extra) => spawnSync(process.execPath,
      ["tools/osd-leak-scan.mjs", root, ...extra], {encoding: "utf8"});
    after(() => rmSync(root, {recursive: true, force: true}));

    it("prints the name without --redact", () => {
      const result = run("--paths", file);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(name));
    });

    it("prints neither the name nor its category with --redact, but still fails", () => {
      const result = run("--paths", file, "--redact");
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, new RegExp(name, "i"));
      assert.doesNotMatch(result.stderr, new RegExp(category));
      assert.match(result.stderr, /категория #1 \(текст\): sha256:[0-9a-f]{8}/);
    });

    it("does not quote a malformed list", () => {
      const broken = mkdtempSync(join(tmpdir(), "osd-leak-broken-"));
      try {
        mkdirSync(join(broken, ".local"), {recursive: true});
        writeFileSync(join(broken, ".local", "leak-identifiers.json"), `{"k": [${name}]}`);
        const result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", broken, "--print-masks"], {encoding: "utf8"});
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(name));
      } finally {
        rmSync(broken, {recursive: true, force: true});
      }
    });

    for (const [label, list] of [
      ["a line break in a name", {k: [`${name}\nmore`]}],
      ["a line break in a category", {[`k\n${name}`]: ["abcdef"]}],
      ["a string where an array belongs", {k: name}],
      ["a name that is not a string", {k: [42]}],
      ["a name too short to scan", {k: ["ab"]}],
      ["a category without names", {k: []}],
      ["no categories at all", {}],
    ]) {
      it(`refuses a list with ${label}, without printing it`, () => {
        const broken = mkdtempSync(join(tmpdir(), "osd-leak-shape-"));
        try {
          mkdirSync(join(broken, ".local"), {recursive: true});
          writeFileSync(join(broken, ".local", "leak-identifiers.json"), JSON.stringify(list));
          const result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", broken, "--print-masks"], {encoding: "utf8"});
          assert.equal(result.status, 1);
          assert.doesNotMatch(result.stdout + result.stderr, new RegExp(name));
          assert.doesNotMatch(result.stdout, /add-mask/);
        } finally {
          rmSync(broken, {recursive: true, force: true});
        }
      });
    }

    it("emits a mask for every name and category", () => {
      const result = run("--print-masks");
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split("\n").sort(),
        [`::add-mask::${category}`, `::add-mask::${name}`].sort());
    });
  });
});
