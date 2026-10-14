#!/usr/bin/env node
import {createHash} from "node:crypto";
// Look for live identifiers in what is about to become public.
//
// The rule in CLAUDE.md is old and it has been walked past twice. Once a wire
// capture nearly went into a public repository as a fixture; that one was
// caught by reading the bytes. Once a 746-byte logon template *did* get
// committed, carrying a system's host name, its instance, its address, a logon
// string and a user name — and a scan written to stop exactly that pronounced
// it clean, because the scan looked for runs of printable ASCII and every
// string in the structure was UTF-16LE. A NUL after each character is enough
// to hide a host name from a grep and from an eye.
//
// So the one idea here: **decode first, match second**. Every file is turned
// into as many byte views as it plausibly has — the text itself, whatever hex
// strings it contains, base64 blocks, and each of those read as UTF-16LE as
// well as ASCII — and the patterns run over all of them. A pattern list that
// only ever sees one encoding is a pattern list that reports clean.
//
// The structural rules need no configuration and catch the cases nobody
// thought to list: addresses in the private ranges, those same addresses
// *packed* into four bytes (which is how a LAN address travels inside a uuid's
// node field without ever spelling itself out), and uuid shapes.
//
// The names in play — hosts, users, clients — cannot be written down here,
// because a list of the identifiers we must not publish is itself a thing we
// must not publish. It lives in `.local/leak-identifiers.json`, which is
// gitignored, and the scan says so when it is missing rather than passing
// quietly: a check that silently loses half its patterns is the failure this
// tool exists to prevent.
import {fileURLToPath} from "node:url";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, relative } from "node:path";

const PRIVATE_V4 =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const CAPTURE = /\.(pcap|pcapng|jsonl)$/i;

// Lock files are megabytes of base64 integrity hashes, nobody writes them by
// hand, and no identifier reaches one except by chance. Scanning them produces
// a page of four-byte coincidences per run, which is how a check teaches its
// readers to skip it.
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/;

// The allowlist names the values it excuses, so scanning it finds every one of
// them and the check reports on its own paperwork. It is read as configuration
// above, and skipped as content here.
const OWN_CONFIG = /(^|\/)\.leak-allow\.json$/;

// Text that is really bytes: a hex run long enough to be a payload, and a
// base64 block. Both are how a capture reaches a source file.
const HEX_RUN = /[0-9a-fA-F]{32,}/g;
const B64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
// Sign-quantized embeddings are deliberately opaque bytes. Decoding thousands
// of them as captures inevitably manufactures packed RFC1918 addresses. Skip
// only the encoded-byte views of valid, generated ZVDB corpus JSON; the
// surrounding document and its ordinary text still go through every rule.
const OPAQUE_VECTOR_HEX = /("(?:vectorHex|qbits)"\s*:\s*")[0-9a-fA-F]{32,}(")/gi;
const ZVDB_VECTOR_JSON = /(^|\/)packs\/zvdb\/(?:data\/zvdb_100_vec\.tabu\.json|fixtures\/corpus\.[^/]+\.json)$/;

function encodedPayloadText(name, text) {
  if (!ZVDB_VECTOR_JSON.test(name)) return text;
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  return text.replace(OPAQUE_VECTOR_HEX, "$1$2");
}

function views(name, text) {
  // Every way these bytes could be read, each one worth matching against.
  const out = [{ how: "текст", text }];
  const bytes = Buffer.from(text, "binary");
  out.push({ how: "utf-16le", text: bytes.toString("utf16le") });

  const encodedPayloads = encodedPayloadText(name, text);
  for (const run of encodedPayloads.match(HEX_RUN) ?? []) {
    const b = Buffer.from(run.length % 2 ? run.slice(0, -1) : run, "hex");
    out.push({ how: "hex→ascii", text: b.toString("latin1"), packed: b });
    out.push({ how: "hex→utf-16le", text: b.toString("utf16le") });
  }
  for (const run of encodedPayloads.match(B64_RUN) ?? []) {
    const b = Buffer.from(run, "base64");
    if (b.length < 8) continue;
    out.push({ how: "base64→ascii", text: b.toString("latin1"), packed: b });
    out.push({ how: "base64→utf-16le", text: b.toString("utf16le") });
  }
  return out;
}

// An address that never spells itself out. The last six bytes of a session
// GUID are the client's MAC or, on the systems here, its IPv4 — four bytes
// that a text search cannot see.
//
// Only the two-byte prefixes, 192.168 and 172.16-31, are worth matching in
// binary. A 10.x address is one byte, which any long blob of random-looking
// bytes produces roughly once per 256, and the first run of this over the Go
// repository turned up seven of them in base64 test vectors and nothing real.
// A check that cries wolf seven times gets read once and ignored after, which
// costs more than the case it would have caught. 192.168 needs two bytes to
// line up and it is what actually leaked.
function packedAddresses(bytes) {
  const found = [];
  if (!bytes) return found;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    const [a, b, c, d] = bytes.subarray(i, i + 4);
    const isPrivate = (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    // A last octet of 0 or 255 is a network or broadcast address, and far more
    // likely to be a coincidence in binary than a real host.
    if (isPrivate && d !== 0 && d !== 255) {
      found.push({ at: i, text: `${a}.${b}.${c}.${d}` });
    }
  }
  return found;
}

// The same names matter in every repository that takes these captures, so the
// list is looked for in the repository being scanned, then where the
// environment points, then in this repository — a sibling Go clone has no
// `.local/` of its own and should not need one to be checked properly.
function identifierList(root) {
  const here = fileURLToPath(new URL("..", import.meta.url));
  let commonCheckout;
  try {
    const commonGit = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    commonCheckout = resolve(commonGit, "..");
  } catch {
    // A path outside Git can still be scanned explicitly; it simply has no
    // main-worktree configuration to inherit.
  }
  const candidates = [
    join(root, ".local", "leak-identifiers.json"),
    process.env.OSD_LEAK_IDENTIFIERS,
    commonCheckout && join(commonCheckout, ".local", "leak-identifiers.json"),
    join(here, ".local", "leak-identifiers.json"),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

// Four bytes that happen to read as an address, in a test vector that has been
// looked at. The allowlist is tracked, unlike the identifier list, because it
// holds no secret — it records a judgement, and the judgement is worth
// reviewing. Each entry needs a reason, so that a later reader can tell a
// considered exception from one somebody added to make the build go green.
function allowed(root) {
  const path = join(root, ".leak-allow.json");
  if (!existsSync(path)) return () => false;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Node's parse error quotes the input; report the file only.
    console.error(`osd-leak-scan: ${path} is not valid JSON (${error.name}); its content is not printed`);
    process.exit(1);
  }
  const keys = new Set();
  for (const entry of raw.allow ?? []) {
    if (!entry.reason) {
      throw new Error(`.leak-allow.json: ${entry.file} ${entry.value} без reason`);
    }
    keys.add(`${entry.file}|${entry.value}`);
  }
  return (file, value) => keys.has(`${file}|${value}`);
}

function identifiers(root) {
  const path = identifierList(root);
  if (!path) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Node's parse error quotes the input, and in CI that input is the secret
    // list and the log is public: say where, never what.
    console.error(`osd-leak-scan: ${path} is not valid JSON (${error.name}); its content is not printed`);
    process.exit(1);
  }
  // The list is checked whole before anything uses it: a name the scan would
  // silently skip (too short, not a string, a string where an array belongs)
  // is coverage lost without a word, and a line break inside a name or a
  // category would split the one-line ::add-mask:: command and leave the rest
  // of it in a public log. Errors name the position, never the content.
  const bad = (where, why) => {
    console.error(`osd-leak-scan: ${path}: ${where}: ${why}; its content is not printed`);
    process.exit(1);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("top level", "not an object of categories");
  if (Object.keys(raw).length === 0) bad("top level", "no categories, so nothing would be checked");
  const list = [];
  Object.entries(raw).forEach(([kind, values], i) => {
    if (/[\r\n]/.test(kind)) bad(`category #${i + 1}`, "a line break in its name");
    if (!Array.isArray(values)) bad(`category #${i + 1}`, "not an array of names");
    if (values.length === 0) bad(`category #${i + 1}`, "no names");
    values.forEach((v, j) => {
      if (typeof v !== "string") bad(`category #${i + 1}, name #${j + 1}`, "not a string");
      if (/[\r\n]/.test(v)) bad(`category #${i + 1}, name #${j + 1}`, "a line break in it");
      if (v.trim().length < 3) bad(`category #${i + 1}, name #${j + 1}`, "shorter than 3 characters, which the scan cannot match without noise");
      list.push({ kind, value: v });
    });
  });
  return list;
}

// Everything about to be pushed, which is not the same as everything in the
// working tree. A commit that introduced an identifier and a later commit that
// removed it leave a clean tree and a history that still carries it, and
// "clean the history before merging" is a step somebody has to remember at
// exactly the right moment — the same shape as the rule that has already
// failed twice. So the range is walked commit by commit and every version of
// every blob it touches is read, along with the messages, which are published
// too and are the easiest place to paste an address into.
function blobsInRange(root, rangeArgs) {
  let commits;
  try {
    // rangeArgs is passed to rev-list whole, so a range that is more than one
    // token survives. The pre-push hook checks the commits actually going out
    // with `<local> --not --remotes=origin`, and reading only the first token
    // dropped the exclusion and walked the entire history instead — which
    // re-flagged every already-public identifier on every push and taught the
    // gate to be ignored, the one failure its own design warns against.
    commits = execFileSync("git", ["rev-list", ...rangeArgs], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).split("\n").filter(Boolean);
  } catch (error) {
    // A hook that dies with a stack trace teaches people to pass --no-verify.
    console.error(`osd-leak-scan: не смог прочитать диапазон ${rangeArgs.join(" ")}: ${error.message.trim().split("\n")[0]}`);
    process.exit(1);
  }
  const out = [];
  const seen = new Set();
  for (const commit of commits) {
    const message = execFileSync("git", ["log", "-1", "--format=%B", commit], {
      cwd: root, encoding: "utf8",
    });
    out.push({ file: `${commit.slice(0, 8)} (сообщение коммита)`, text: message });

    const names = execFileSync(
      "git", ["diff-tree", "-r", "--no-commit-id", "--name-only", "--diff-filter=ACMR", commit],
      { cwd: root, encoding: "utf8" },
    ).split("\n").filter(Boolean);
    for (const name of names) {
      const key = `${commit}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const buf = execFileSync("git", ["show", `${commit}:${name}`], {
          cwd: root, maxBuffer: 64 * 1024 * 1024,
        });
        out.push({ file: `${name} @ ${commit.slice(0, 8)}`, realFile: name, text: buf.toString("latin1") });
      } catch {
        // Deleted, or a submodule. Neither has content to read here.
      }
    }
  }
  return out;
}

function scan(root, sources, names) {
  const hits = [];
  const isAllowed = allowed(root);
  for (const source of sources) {
    const file = typeof source === "string" ? source : source.file;
    const forAllow = typeof source === "string" ? file : (source.realFile ?? file);
    if (GENERATED.test(forAllow) || OWN_CONFIG.test(forAllow)) continue;
    if (CAPTURE.test(forAllow)) {
      hits.push({ file, how: "имя файла", what: "захват", text: file });
      continue;
    }
    let text;
    if (typeof source === "string") {
      try {
        text = readFileSync(resolve(root, file), "latin1");
      } catch {
        continue;
      }
    } else {
      text = source.text;
    }
    if (text.length > 8 * 1024 * 1024) continue;

    const seen = new Set();
    const note = (how, what, value) => {
      if (isAllowed(forAllow, value)) return;
      const key = `${file}|${what}|${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ file, how, what, text: value });
    };

    for (const view of views(forAllow, text)) {
      for (const m of view.text.match(PRIVATE_V4) ?? []) {
        note(view.how, "частный адрес", m);
      }
      for (const m of view.text.match(UUID) ?? []) note(view.how, "uuid", m);
      for (const { text: addr } of packedAddresses(view.packed)) {
        note(view.how + " (упакован)", "частный адрес", addr);
      }
      if (names) {
        const hay = view.text.toLowerCase();
        for (const { kind, value } of names) {
          if (hay.includes(value.toLowerCase())) note(view.how, kind, value);
        }
      }
    }
  }
  return hits;
}

function stagedFiles(root) {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: root, encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

// Files named on the command line, walked if they are directories, whether or
// not git has ever heard of them. Everything else here asks git what to look
// at, which is right for a commit and wrong for the thing most likely to be
// pasted into a public tracker: a draft under .local/. Asked to scan such a
// folder, the tracked-file modes answer "0 files, 0 matches", which reads
// exactly like a pass (2026-09-17).
function namedFiles(root, paths) {
  const out = [];
  const walk = (abs) => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) {
        if (entry === ".git" || entry === "node_modules") continue;
        walk(join(abs, entry));
      }
      return;
    }
    const rel = relative(root, abs);
    out.push(rel.startsWith("..") ? abs : rel);
  };
  for (const p of paths) walk(resolve(root, p));
  return out;
}

const args = process.argv.slice(2);
// the root positional is only what stands before --paths / --range, whose own
// arguments are positionals too and are not the root
const beforeLists = args.slice(0, Math.min(
  ...[args.indexOf("--paths"), args.indexOf("--range")].filter((i) => i >= 0).concat([args.length]),
));
const rootArg = beforeLists.find((a) => !a.startsWith("--")) ?? ".";
const root = resolve(rootArg);
const all = args.includes("--all");
const rangeAt = args.indexOf("--range");
// everything after --range is passed to rev-list, minus the root positional
// wherever it landed: `--range <local> --not --remotes=origin` is three tokens,
// and only the whole of it names the commits a push actually adds.
const rangeArgs = rangeAt >= 0 ? args.slice(rangeAt + 1).filter((a) => a !== rootArg) : null;
const pathsAt = args.indexOf("--paths");
const pathArgs = pathsAt >= 0 ? args.slice(pathsAt + 1).filter((a) => !a.startsWith("--")) : null;

const names = identifiers(root);
// In CI the list comes from an Actions secret and the log is public, so a hit
// must not print the very name it caught, nor the category it is filed under
// (a category name can say more than the name). --redact prints the file, the
// kind of view, a category number and a short hash of the value; the same scan
// on a machine with the list says what it is. --print-masks emits one
// ::add-mask:: line per name and category, so the runner masks them anywhere
// in the log as a second guard.
const redact = args.includes("--redact") || process.env.OSD_LEAK_REDACT === "1";
if (args.includes("--print-masks")) {
  const seenMask = new Set();
  for (const { kind, value } of names ?? []) {
    for (const s of [kind, value]) {
      if (seenMask.has(s)) continue;
      seenMask.add(s);
      console.log(`::add-mask::${s}`);
    }
  }
  process.exit(names ? 0 : 2);
}
const kinds = [...new Set((names ?? []).map((n) => n.kind))];
const shown = (h) => {
  if (!redact) return `${h.what} (${h.how}): ${h.text}`;
  const n = kinds.indexOf(h.what);
  const label = n >= 0 ? `имя из списка, категория #${n + 1}` : h.what;
  const digest = createHash("sha256").update(h.text.toLowerCase()).digest("hex").slice(0, 8);
  return `${label} (${h.how}): sha256:${digest}`;
};
const files = pathArgs
  ? namedFiles(root, pathArgs)
  : rangeArgs ? blobsInRange(root, rangeArgs) : all ? trackedFiles(root) : stagedFiles(root);
const hits = scan(root, files, names);

if (!names) {
  console.error(
    "osd-leak-scan: нет .local/leak-identifiers.json — структурные правила работают,\n" +
    "               но имена хостов и пользователей не проверены. Это половина проверки.",
  );
}
console.error(`osd-leak-scan: ${files.length} файлов, ${hits.length} совпадений`);

// Nothing looked at is not a pass. A scan that reads no file prints the same
// reassuring line as a clean one, which is how a folder of drafts under
// .local/ was called clean by a check that could not see it. Only the
// explicit mode fails on it: staging nothing, or pushing nothing, is a
// legitimate empty set and must not block a commit.
if (files.length === 0) {
  const explicit = pathArgs !== null;
  console.error(
    "osd-leak-scan: ни одного файла не прочитано — это не \"чисто\", это \"нечего было смотреть\"." +
    (explicit ? "" : "\n               Для файлов вне git: node tools/osd-leak-scan.mjs --paths <путь> [<путь>…]"),
  );
  if (explicit) process.exit(2);
}

if (hits.length) {
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  console.error("");
  for (const [file, list] of byFile) {
    console.error(`  ${file}`);
    for (const h of list) console.error(`      ${shown(h)}`);
  }
  console.error("");
  console.error("Это публичный репозиторий. Вычисти или положи под .local/.");
  process.exit(1);
}
if (!names) process.exit(2);
