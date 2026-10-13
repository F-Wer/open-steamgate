package storecompiler

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"osg/gogen/compiler"
	"osg/gogen/storecheck"
)

// Use the actual Node report/sidecar producers, then carry their diagnostics
// through the Go client, adapter and EV_JSON encoder. Cold/warm include and
// fallback cases also remain covered by TestCheckRunNodeReportGoldens.
func TestCheckRunDiagnosticURIs(t *testing.T) {
	cmd := exec.Command("node", "--input-type=module", "-e", `
import {checkRunReport} from "./tools/adt-checkrun.mjs";
import {diagnostic} from "./tools/osd-compiler-sidecar.mjs";
const object = {type:"INCL", name:"ZINCLUDE"};
const cases = {
  include: {type:"CLAS", name:"ZCLASS", file:"/src/zclass.clas.locals_def.abap"},
  fallback: {type:"PROG", name:"ZREPORT"},
  incl: {},
  "incl-typed": {type:"INCL", name:"ZINCLUDE"},
  "incl-program-frame": {type:"PROG", name:"zinclude", file:"/src/zinclude.prog.abap"},
};
const out = {};
for (const [name, issue] of Object.entries(cases)) {
  const report = await checkRunReport({check: () => ({issues:[{message:name, ...issue}]})}, object);
  out[name] = {diagnostics:report.issues.map(i => diagnostic({...i, ...object}))};
}
process.stdout.write(JSON.stringify(out));`)
	cmd.Dir = filepath.Join("..", "..", "..", "..")
	raw, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	fixture := filepath.Join(root, "reports.json")
	if err := os.WriteFile(fixture, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "zinclude.prog.abap"), []byte("* include"), 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("STORECOMPILER_FAKE", "1")
	t.Setenv("STORECOMPILER_REPORT_FIXTURE", fixture)
	t.Setenv("OSGO_SIDECAR", executable)
	client := compiler.New(compiler.Options{Root: root})
	defer client.Close()
	for name, uri := range map[string]string{
		"include":            "/sap/bc/adt/oo/classes/zclass/includes/definitions",
		"fallback":           "/sap/bc/adt/programs/programs/zreport/source/main",
		"incl":               "/sap/bc/adt/programs/includes/zinclude",
		"incl-typed":         "/sap/bc/adt/programs/includes/zinclude",
		"incl-program-frame": "/sap/bc/adt/programs/includes/zinclude",
	} {
		t.Run(name, func(t *testing.T) {
			rows, err := (Adapter{client}).Check(context.Background(), storecheck.Input{Root: root, Generation: "test", Type: "INCL", Name: "ZINCLUDE", Version: "inactive", Files: []string{"zinclude.prog.abap"}, CheckRun: true, Include: name})
			if err != nil {
				t.Fatal(err)
			}
			var report storecheck.Report
			if err := json.Unmarshal([]byte(storecheck.Processed(rows).Scalars["EV_JSON"]), &report); err != nil {
				t.Fatal(err)
			}
			if report.Status != "processed" || len(report.Issues) != 1 || report.Issues[0].URI != uri {
				t.Fatalf("report: %+v; want uri %s", report, uri)
			}
		})
	}
}
