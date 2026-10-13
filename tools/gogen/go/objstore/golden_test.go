package objstore

import (
	"context"
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type goldenAnswer struct {
	Scalars   map[string]string `json:"scalars"`
	Objects   []Row             `json:"objects"`
	Issues    []Issue           `json:"issues"`
	Types     []Tally           `json:"types"`
	Revisions []Revision        `json:"revisions"`
}

type wireAnswer struct {
	Scalars   map[string]string `json:"-"`
	Objects   []Row             `json:"ET_OBJECT"`
	Issues    []Issue           `json:"ET_ISSUE"`
	Types     []Tally           `json:"ET_TYPE"`
	Revisions []Revision        `json:"ET_REVISION"`
}

func (w *wireAnswer) UnmarshalJSON(data []byte) error {
	var top struct {
		Scalars   map[string]string
		Objects   []Row      `json:"ET_OBJECT"`
		Issues    []Issue    `json:"ET_ISSUE"`
		Types     []Tally    `json:"ET_TYPE"`
		Revisions []Revision `json:"ET_REVISION"`
	}
	if err := json.Unmarshal(data, &top); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for key, raw := range fields {
		if !strings.HasPrefix(key, "EV_") {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		if top.Scalars == nil {
			top.Scalars = map[string]string{}
		}
		top.Scalars[key] = value
	}
	*w = wireAnswer{top.Scalars, top.Objects, top.Issues, top.Types, top.Revisions}
	return nil
}

var goldenCases = []struct {
	name       string
	parameters map[string]string
}{
	{"object-class", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS"}},
	{"object-tmp", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZTMP_PROG"}},
	{"object-overlay", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZARCHIVE"}},
	{"object-overlay-write", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZOVERLAY"}},
	{"object-full", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZFULLSUB"}},
	{"object-library", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZLIBRARY"}},
	{"object-missing", map[string]string{"IV_COMMAND": "OBJECT", "IV_TYPE": "PROG", "IV_NAME": "ZMISSING"}},
	{"package-raw", map[string]string{"IV_COMMAND": "PACKAGE", "IV_JSON": `{"mode":"raw","name":"$STG"}`}},
	{"package-local", map[string]string{"IV_COMMAND": "PACKAGE", "IV_JSON": `{"mode":"local","name":"$TMP","user":"ALICE"}`}},
	{"packages-json", map[string]string{"IV_COMMAND": "PACKAGES", "IV_JSON": `{}`}},
	{"packages-lines", map[string]string{"IV_COMMAND": "PACKAGES", "IV_JSON": `{"format":"lines"}`}},
	{"packages-vfs-lines", map[string]string{"IV_COMMAND": "PACKAGES", "IV_JSON": `{"format":"vfs-lines"}`}},
	{"search-json", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":100}`}},
	{"search-empty", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":""}`}},
	{"search-spaced", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":" 2 "}`}},
	{"search-hex", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":"0x2"}`}},
	{"search-true", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":true}`}},
	{"search-false", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":false}`}},
	{"search-negative", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":-2}`}},
	{"search-null", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":null}`}},
	{"search-invalid", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":"junk"}`}},
	{"search-zero", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","limit":0}`}},
	{"search-lines", map[string]string{"IV_COMMAND": "SEARCH", "IV_JSON": `{"seed":"Z","type":"PROG","format":"lines"}`}},
	{"system-identity", map[string]string{"IV_COMMAND": "SYSTEM", "IV_TYPE": "IDENTITY"}},
	{"system-known-kind", map[string]string{"IV_COMMAND": "SYSTEM", "IV_TYPE": "LOCK_HANDLE"}},
	{"system-unknown-kind", map[string]string{"IV_COMMAND": "SYSTEM", "IV_TYPE": "NOPE"}},
	{"read-main", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS"}},
	{"read-include", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS", "IV_INCLUDE": "definitions"}},
	{"read-zero-include", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "CLAS", "IV_NAME": "ZEMPTY", "IV_INCLUDE": "definitions"}},
	{"read-active-main", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "PROG", "IV_NAME": "ZPROGRAM", "IV_REVISION": "active"}},
	{"read-active-include", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS", "IV_INCLUDE": "definitions", "IV_REVISION": "active"}},
	{"read-missing-include", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS", "IV_INCLUDE": "macros"}},
	{"read-library", map[string]string{"IV_COMMAND": "READ", "IV_TYPE": "PROG", "IV_NAME": "ZLIBRARY"}},
	{"history-main", map[string]string{"IV_COMMAND": "HISTORY", "IV_TYPE": "PROG", "IV_NAME": "ZPROGRAM"}},
	{"history-rename", map[string]string{"IV_COMMAND": "HISTORY", "IV_TYPE": "PROG", "IV_NAME": "Z_NEW"}},
	{"history-ignored", map[string]string{"IV_COMMAND": "HISTORY", "IV_TYPE": "PROG", "IV_NAME": "ZIGNORED"}},
	{"history-include", map[string]string{"IV_COMMAND": "HISTORY", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS", "IV_INCLUDE": "macros"}},
	{"checkrun-clean", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCL_VALID"}},
	{"checkrun-existing-include", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCLASS", "IV_INCLUDE": "definitions"}},
	{"checkrun-absent-include", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCL_VALID", "IV_INCLUDE": "macros"}},
	{"checkrun-amdp", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCL_PORTABLE"}},
	{"checkrun-amdp-include", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCL_PORTABLE", "IV_INCLUDE": "macros"}},
	{"checkrun-syntax", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZCL_BAD"}},
	{"checkrun-non-source", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "TABL", "IV_NAME": "ZTABLE"}},
	{"checkrun-structure", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "STRU", "IV_NAME": "ZSTRUCT"}},
	{"checkrun-missing-structure", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "STRU", "IV_NAME": "ZMISSING"}},
	{"checkrun-missing", map[string]string{"IV_COMMAND": "CHECKRUN", "IV_TYPE": "CLAS", "IV_NAME": "ZMISSING"}},
}

func TestStoreDestinationGoldens(t *testing.T) {
	t.Setenv("OSD_LOCAL_PACKAGES", "$STG_A,$STG__,$STG")
	script := filepath.Join("..", "..", "..", "osgo-store-fixture.mjs")
	output, err := osexec.Command("node", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	root := strings.TrimSpace(string(output))
	config, err := os.ReadFile(filepath.Join(root, "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := SetStore(root, config, ""); err != nil {
		t.Fatal(err)
	}
	SetSystemIdentity(Identity{SystemID: "OSD", Client: "001", UserName: "OSD"})
	defer func() {
		SetCompiler(nil, "")
		SetStore("", nil, "")
	}()
	goldenBytes, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "fixtures", "osgo-store", "destination-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]wireAnswer
	if err := json.Unmarshal(goldenBytes, &raw); err != nil {
		t.Fatal(err)
	}
	for _, test := range goldenCases {
		if test.name == "checkrun-clean" {
			prepare := osexec.Command("node", "--input-type=module", "-e", `import {prepareCompilerFixture} from "./tools/osgo-store-goldens.mjs"; await prepareCompilerFixture(process.argv.at(-1));`, root)
			prepare.Dir = filepath.Join(filepath.Dir(script), "..")
			prepare.Stderr = os.Stderr
			if err := prepare.Run(); err != nil {
				t.Fatal(err)
			}
			if err := SetStore(root, config, ""); err != nil {
				t.Fatal(err)
			}
			SetCompiler(goldenCompiler{}, "test")
		}
		t.Run(test.name, func(t *testing.T) {
			input := map[string]*string{}
			for key, value := range test.parameters {
				value := value
				input[key] = &value
			}
			answer := Call(input)
			answer.Scalars["EV_MS"] = "0"
			for i := range answer.Revisions {
				answer.Revisions[i].path = ""
			}
			want := goldenAnswer{raw[test.name].Scalars, raw[test.name].Objects,
				raw[test.name].Issues, raw[test.name].Types, raw[test.name].Revisions}
			got := goldenAnswer{answer.Scalars, answer.Objects, answer.Issues, answer.Types, answer.Revisions}
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("answer differs\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

type goldenCompiler struct{}

func (goldenCompiler) Available(context.Context) error { return nil }
func (goldenCompiler) Check(_ context.Context, in CompilerInput) ([]Issue, error) {
	if in.Type == "CLAS" && in.Name == "ZCL_BAD" {
		return []Issue{{OBJ_TYPE: "CLAS", OBJ_NAME: "ZCL_BAD", Severity: "E", LINE: 3, COL: 10,
			URI: "/sap/bc/adt/oo/classes/zcl_bad/source/main",
			MESSAGE: `Method name "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" is too long, maximum length is 30 characters`}}, nil
	}
	if in.Name == "ZCL_PORTABLE" && in.Include == "main" {
		return []Issue{{Severity: "W", LINE: 7, COL: 1, URI: "/sap/bc/adt/oo/classes/zcl_portable/source/main", MESSAGE: "Portable AMDP: not supported on sqlite: CAST to INTEGER cannot raise in SQLite: it returns 0 where HANA and DuckDB raise"}}, nil
	}

	return nil, nil
}
func (goldenCompiler) Outline(context.Context, CompilerInput) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func TestStoreHistoryStateUsesGitStatus(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	storeState.root = root
	defer func() { storeState.root = "" }()
	state, changed := storeHistoryState(root, "file")
	if state != "modified" {
		t.Fatalf("state outside a repository: %q", state)
	}
	if _, err := time.Parse(time.RFC3339, strings.Replace(changed, "Z", "+00:00", 1)); err != nil && changed != "1970-01-01T00:00:00.000Z" {
		t.Fatalf("changed time: %q (%v)", changed, err)
	}
}

func TestStoreHistoryStateUnbornAndIgnored(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored.prog.abap\n"), 0o644)
	os.MkdirAll(filepath.Join(root, "src"), 0o755)
	tracked := filepath.Join(root, "src", "tracked.prog.abap")
	ignored := filepath.Join(root, "src", "ignored.prog.abap")
	os.WriteFile(tracked, []byte("tracked\n"), 0o644)
	os.WriteFile(ignored, []byte("ignored\n"), 0o644)
	fixed := time.Date(2026, 10, 1, 12, 34, 56, 789000000, time.UTC)
	os.Chtimes(tracked, fixed, fixed)
	os.Chtimes(ignored, fixed, fixed)
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Test Author"},
		{"config", "user.email", "test@example.invalid"}, {"add", "src/tracked.prog.abap"}} {
		if _, err := storeGit(root, args...); err != nil {
			t.Fatal(err)
		}
	}
	state, changed := storeHistoryState(root, "src/tracked.prog.abap")
	if state != "modified" || changed != "2026-10-01T12:34:56.789Z" {
		t.Fatalf("unborn repository: %q %q", state, changed)
	}
	state, changed = storeHistoryState(root, "src/ignored.prog.abap")
	if state != "modified" || changed != "2026-10-01T12:34:56.789Z" {
		t.Fatalf("ignored file: %q %q", state, changed)
	}
}

func TestStoreReadExistingIncludeErrorPropagates(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads files regardless of mode")
	}
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "src"), 0o755)
	os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte("{}\n"), 0o644)
	os.WriteFile(filepath.Join(root, "src", "zclass.clas.abap"), []byte("CLASS zclass.\nENDCLASS.\n"), 0o644)
	include := filepath.Join(root, "src", "zclass.clas.locals_def.abap")
	os.WriteFile(include, []byte("definitions\n"), 0o644)
	os.Chmod(include, 0o000)
	defer SetStore("", nil, "")
	if err := SetStore(root, []byte(`{"roots":[{"path":"src","writable":true,"library":false}]}`), ""); err != nil {
		t.Fatal(err)
	}
	str := func(value string) *string { return &value }
	answer := Call(map[string]*string{"IV_COMMAND": str("READ"), "IV_TYPE": str("CLAS"), "IV_NAME": str("ZCLASS"), "IV_INCLUDE": str("definitions")})
	if answer.Scalars["EV_ERROR"] == "" || !strings.Contains(answer.Scalars["EV_ERROR"], "zclass.clas.locals_def.abap") {
		t.Fatalf("existing include read error was swallowed: %v", answer.Scalars)
	}
}

func TestSystemIdentity(t *testing.T) {
	SetSystemIdentity(Identity{SystemID: "XYZ", Client: "001", UserName: "OSD"})
	defer SetSystemIdentity(Identity{})
	str := func(value string) *string { return &value }
	answer := Call(map[string]*string{"IV_COMMAND": str("SYSTEM"), "IV_TYPE": str("IDENTITY")})
	if answer.Scalars["EV_ERROR"] != "" || answer.Scalars["EV_JSON"] != `{"systemID":"XYZ","client":"001","userName":"OSD"}` {
		t.Fatalf("identity answer: %v", answer.Scalars)
	}
}

func TestSystemKindRefusals(t *testing.T) {
	SetSystemIdentity(Identity{SystemID: "XYZ", Client: "001", UserName: "OSD"})
	defer SetSystemIdentity(Identity{})
	str := func(value string) *string { return &value }
	tests := []struct {
		kind  string
		error string
	}{
		{"LOCK_HANDLE", "SYSTEM LOCK_HANDLE has no answer here"},
		{"XREF_WARM", "SYSTEM XREF_WARM has no answer here"},
		{"NOPE", "unknown SYSTEM kind NOPE"},
		{"", "unknown SYSTEM kind (none)"},
	}
	for _, test := range tests {
		answer := Call(map[string]*string{"IV_COMMAND": str("SYSTEM"), "IV_TYPE": str(test.kind)})
		if answer.Scalars["EV_ERROR"] != test.error {
			t.Fatalf("SYSTEM %q: got %q, want %q", test.kind, answer.Scalars["EV_ERROR"], test.error)
		}
	}
}

func TestStoreReadActiveVersion(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "src", "active.prog.abap")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("REPORT active.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "unproven.prog.abap"), []byte("REPORT unproven.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	if err := SetStore(root, []byte(`{"roots":[{"path":"src","writable":true,"library":false}]}`), ""); err != nil {
		t.Fatal(err)
	}
	storeState.cfg.Built = map[string]string{"src/active.prog.abap": storeDigest("src/active.prog.abap")}
	storeState.cfg.Active = map[string]string{"src/active.prog.abap": "src/active.prog.abap"}
	str := func(value string) *string { return &value }
	answer := Call(map[string]*string{"IV_COMMAND": str("READ"), "IV_TYPE": str("PROG"), "IV_NAME": str("ACTIVE"), "IV_REVISION": str("active")})
	if answer.Scalars["EV_ERROR"] != "" || answer.Scalars["EV_SOURCE"] != "REPORT active.\n" {
		t.Fatalf("active read: %v", answer.Scalars)
	}
	answer = Call(map[string]*string{"IV_COMMAND": str("READ"), "IV_TYPE": str("PROG"), "IV_NAME": str("UNPROVEN"), "IV_REVISION": str("active")})
	if answer.Scalars["EV_ERROR"] != "PROG UNPROVEN active version (main) does not exist" {
		t.Fatalf("active refusal: %v", answer.Scalars)
	}
}
