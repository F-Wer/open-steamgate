package storecompiler

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"osg/gogen/compiler"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
)

// Re-execute this test binary so Check exercises the real client transport.
func TestMain(m *testing.M) {
	if os.Getenv("STORECOMPILER_FAKE") == "1" {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			var request struct {
				ID       uint64            `json:"id"`
				Op       string            `json:"op"`
				Snapshot compiler.Snapshot `json:"snapshot"`
			}
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				os.Exit(2)
			}
			response := map[string]any{"id": request.ID}
			if request.Op == "hello" {
				response["contract"], response["osd"], response["transpiler"] = 1, "test", "test"
				response["capabilities"] = []string{"check", "outline"}
				response["limits"] = compiler.Limits{MaxSnapshotBytes: 1024, MaxConcurrentRequests: 1}
			} else {
				if request.Snapshot.CheckMode == "checkrun" {
					path := os.Getenv("STORECOMPILER_REPORT_FIXTURE")
					if path == "" {
						path = filepath.Join("..", "..", "..", "..", "test", "fixtures", "osgo-store", "checkrun-report-golden.json")
					}
					raw, err := os.ReadFile(path)
					if err != nil {
						panic(err)
					}
					var goldens map[string]struct{ Diagnostics json.RawMessage }
					if err := json.Unmarshal(raw, &goldens); err != nil {
						panic(err)
					}
					response["diagnostics"] = goldens[request.Snapshot.Include].Diagnostics
					response["registryHash"], response["configSha"], response["inputCount"] = strings.Repeat("a", 64), strings.Repeat("b", 64), 1
					bytes, _ := json.Marshal(response)
					fmt.Println(string(bytes))
					continue
				}
				file := request.Snapshot.Objects[0].Files[0]
				if request.Snapshot.CheckMode != "saved" || file.LogicalPath != "src/ztest.prog.abap" || file.Path != "copies/digest" || len(request.Snapshot.Objects[0].Files) != 2 || request.Snapshot.Objects[0].Files[1].LogicalPath != "src/other.prog.abap" {
					response["error"] = compiler.Refusal{Code: "BAD_REQUEST", Text: "lost saved mode or explicit filename"}
				} else {
					response["diagnostics"] = []compiler.Diagnostic{
						{Object: compiler.ObjectID{Type: "PROG", Name: "ZTEST"}, Include: "/src/ztest.prog.abap", Line: 2, Col: 0, Rule: "syntax", Text: "first"},
						{Object: compiler.ObjectID{Type: "PROG", Name: "ZOTHER"}, Include: "src/zother.prog.abap", Line: 4, Col: 7, Text: "dependent"},
						{Object: compiler.ObjectID{Type: "CLAS", Name: "ZTEST"}, Line: 1, Text: "wrong type"},
						{Object: compiler.ObjectID{Type: "PROG", Name: "ZTEST"}, Line: 3, Col: 5, Text: "no include or rule"},
					}
					response["registryHash"], response["configSha"], response["inputCount"] = strings.Repeat("a", 64), strings.Repeat("b", 64), 1
				}
			}
			bytes, _ := json.Marshal(response)
			fmt.Println(string(bytes))
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestCheckIssuesAndLogicalSource(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "copies"), 0700)
	os.WriteFile(filepath.Join(root, "copies/digest"), []byte("REPORT ztest."), 0600)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSGO_SIDECAR", executable)
	t.Setenv("STORECOMPILER_FAKE", "1")
	client := compiler.New(compiler.Options{Root: root})
	defer client.Close()
	adapter := Adapter{Client: client}
	got, err := adapter.Check(context.Background(), objstore.CompilerInput{Root: root, Generation: "test", Type: "PROG", Name: "ZTEST", Version: "inactive", Files: []string{"copies/digest", "copies/digest"}, Logical: []string{"src/ztest.prog.abap", "src/other.prog.abap"}})
	want := []objstore.Issue{
		{OBJ_TYPE: "PROG", OBJ_NAME: "ZTEST", FILE: "/src/ztest.prog.abap", LINE: 2, COL: 1, RULE: "syntax", MESSAGE: "first"},
		{OBJ_TYPE: "PROG", OBJ_NAME: "ZTEST", LINE: 3, COL: 6, MESSAGE: "no include or rule"},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("Check: %v, %v; want %v", got, err, want)
	}
}

func TestCheckRunNodeReportGoldens(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "fixtures", "osgo-store", "checkrun-report-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var goldens map[string]struct{ Report json.RawMessage }
	if err = json.Unmarshal(raw, &goldens); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "zreport.prog.abap"), []byte("REPORT zreport."), 0600)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("STORECOMPILER_FAKE", "1")
	t.Setenv("OSGO_SIDECAR", executable)
	client := compiler.New(compiler.Options{Root: root})
	defer client.Close()
	for name, golden := range goldens {
		t.Run(name, func(t *testing.T) {
			rows, err := (Adapter{client}).Check(context.Background(), storecheck.Input{Root: root, Generation: "test", Type: "PROG", Name: "ZREPORT", Version: "inactive", Files: []string{"zreport.prog.abap"}, Logical: []string{"zreport.prog.abap"}, CheckRun: true, Include: name})
			if err != nil {
				t.Fatal(err)
			}
			got := storecheck.Processed(rows).Scalars["EV_JSON"]
			var expected any
			json.Unmarshal(golden.Report, &expected)
			compact, _ := json.Marshal(expected)
			// Compare structure because Go's map encoding sorts keys.
			var actual any
			json.Unmarshal([]byte(got), &actual)
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("got %s want %s", got, compact)
			}
		})
	}
}
