// osabap runs one converted ABAP report as a native command. Arguments fill
// the report selection screen; with no arguments, a terminal form presents
// the same screen before the report lifecycle continues. -sapgui presents it
// to a real SAP GUI over DIAG instead.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/pprof"
	"strings"

	"github.com/gdamore/tcell/v2"
	"osg/gogen/abap"
	"osg/gogen/filepick"
	"osg/gogen/profiling"
	"osg/gogen/readgrant"
	"osg/gogen/reportargs"
	"osg/gogen/sysid"
	"osg/gogen/termgui"
)

func hostRun(s *abap.Session, report ZIF_GG_REPORT_V1, input []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, batch, present string) ZCL_GG_HOST__TY_RESULT {
	return hostRunRequest(s, report, input, batch, present, "")
}

func hostRunRequest(s *abap.Session, report ZIF_GG_REPORT_V1, input []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, batch, present, valueRequest string) ZCL_GG_HOST__TY_RESULT {
	values := make([]*ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, len(input))
	for i := range input {
		values[i] = &input[i]
	}
	empty := []*ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE(nil)
	return ZCL_GG_HOST_RUN(s, report, nil, appProgram, "1000", "", 0, batch,
		&values, &empty, &empty, "ONLI", "", valueRequest, "", "", 0, 1, "", "", "", 0,
		"", "", "", "", "", present, "", &ZIF_GG_HOST_HTML_V1__TY_NAVIGATION{}, &ZIF_GG_SESSION_TYPES_V1__TY_SUBMIT{})
}

var stopProfile = func() {}
var profileReports bool
var dialogSandbox *abap.Sandbox

func main() {
	// sy-sysid: the one system id, by the rule of tools/osd-identity.mjs
	abap.SysID, _ = sysid.Must(os.LookupEnv)
	// OSABAP_CPUPROFILE=<file>: Go's CPU profile of the whole run, for
	// go tool pprof; an environment variable, so no report option is taken
	if path := os.Getenv("OSABAP_CPUPROFILE"); path != "" {
		if f, err := os.Create(path); err == nil && pprof.StartCPUProfile(f) == nil {
			stopProfile = func() { pprof.StopCPUProfile(); f.Close() }
		}
	}
	profileReports = os.Getenv("OSD_PPROF") == "1" || os.Getenv("OSABAP_CPUPROFILE") != ""
	var result ZCL_GG_HOST__TY_RESULT
	failed := false
	cancelled := false
	profiling.Report(profileReports, appProgram, "", func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintln(os.Stderr, "osabap:", withoutDB(r))
				failed = true
			}
		}()
		s := &abap.Session{Statics: abap.ProcessStatics}
		cli := commandLine(os.Args[1:])
		sapGUI, launchSAPGUI, listen := sapGUIOption(cli.Host)
		dbOption(cli.Host)
		input, headless := commandInput(cli)
		datasetOptions(cli.Host, input)
		report := newReport(s)
		if sapGUI {
			var screen ZCL_GG_HOST__TY_RESULT
			abap.DialogStep(func() { screen = hostRun(s, report, input, "", "X") })
			if err := serveSAPGUI(listen, launchSAPGUI, screen, func(values []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE) ZCL_GG_HOST__TY_RESULT {
				var out ZCL_GG_HOST__TY_RESULT
				abap.DialogStep(func() { out = hostRun(s, report, values, "", "") })
				return out
			}); err != nil {
				panic(err)
			}
			cancelled = true // the result lived in SAP GUI, not on stdout
			return
		}
		if headless {
			abap.DialogStep(func() { result = hostRun(s, report, input, "X", "") })
		} else {
			var screen ZCL_GG_HOST__TY_RESULT
			abap.DialogStep(func() { screen = hostRun(s, report, nil, "", "X") })
			if termgui.Available() {
				var err error
				input, err = graphicalInput(s, report, screen)
				if errors.Is(err, termgui.ErrCancelled) {
					cancelled = true
					return
				}
				if err != nil {
					panic(err)
				}
			} else {
				input = terminalInput(screen)
			}
			abap.DialogStep(func() { result = hostRun(s, report, input, "", "") })
		}
	})()
	if dialogSandbox != nil {
		_ = dialogSandbox.Close()
	}
	// the -db file is whole only once it is closed: it is opened in WAL mode,
	// and until the last connection closes, the rows live in <file>-wal
	closeDB()
	stopProfile() // before any os.Exit, which runs no deferred call
	if cancelled {
		return
	}
	if failed {
		os.Exit(1)
	}
	for _, m := range result.messages {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(m.text))
	}
	for _, line := range result.lines {
		fmt.Println(strings.TrimRight(line, " "))
	}
	if result.unsupported != "" {
		fmt.Fprintln(os.Stderr, "unsupported:", result.unsupported)
		os.Exit(2)
	}
	// a MESSAGE of any type but I and S ended the run (the host raises for
	// E, A, W and X alike): on a system a background job with one is
	// cancelled, so a script sees a failure (S DISPLAY LIKE 'E' does not count)
	for _, m := range result.messages {
		if m.type_ != "I" && m.type_ != "S" {
			os.Exit(1)
		}
	}
}

// commandLine reads the arguments once; -help prints the usage and ends here
func commandLine(args []string) reportargs.Result {
	cli, err := reportargs.Parse(args, reportargs.HostFlags, reportargs.Report{Names: appSelectionNames, Checkboxes: appCheckboxes})
	if err != nil {
		panic(err)
	}
	for _, warning := range cli.Warnings {
		fmt.Fprintln(os.Stderr, "osabap:", warning)
	}
	if cli.Help {
		usage()
		os.Exit(0)
	}
	return cli
}

// datasetOptions installs a fresh sandbox from the dataset flags, even when
// the parent process carries dataset env vars.
func datasetOptions(host []reportargs.Arg, input []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE) {
	var read, write []string
	var home, audit string
	for _, flag := range host {
		switch flag.Name {
		case "allow-read":
			if strings.ContainsRune(flag.Value, filepath.ListSeparator) {
				panic(fmt.Errorf("-allow-read accepts one directory per flag"))
			}
			read = append(read, flag.Value)
		case "allow-write":
			if strings.ContainsRune(flag.Value, filepath.ListSeparator) {
				panic(fmt.Errorf("-allow-write accepts one directory per flag"))
			}
			write = append(write, flag.Value)
		case "dataset-home":
			home = flag.Value
		case "dataset-audit":
			audit = flag.Value
		}
	}
	// SandboxFromEnv owns audit creation and root normalization. These values
	// replace inherited grants, so an unflagged command remains denied.
	for key, value := range map[string]string{
		"OSD_DATASET_READ":  strings.Join(read, string(filepath.ListSeparator)),
		"OSD_DATASET_WRITE": strings.Join(write, string(filepath.ListSeparator)),
		"OSD_DATASET_HOME":  home,
		"OSD_DATASET_AUDIT": audit,
	} {
		if err := os.Setenv(key, value); err != nil {
			panic(err)
		}
	}
	dialogSandbox = abap.SandboxFromEnv()
	values := map[string]string{}
	for _, v := range input {
		values[strings.TrimSpace(v.name)] = strings.TrimRight(v.value, " ")
	}
	disabled := false
	for _, flag := range host {
		if flag.Name == "no-default-reads" {
			disabled = true
		}
	}
	readgrant.Apply(dialogSandbox, values, appReadParams, appReadLists, disabled, os.Stderr)
	// Pin root and file identities before report construction or INITIALIZATION.
	_ = dialogSandbox.BrowseRoots(false)
	abap.SetDatasetHost(dialogSandbox)
}

func graphicalInput(s *abap.Session, report ZIF_GG_REPORT_V1, screen ZCL_GG_HOST__TY_RESULT) ([]ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, error) {
	fields, err := termgui.Run(graphicalForm(s, report, screen))
	if err != nil {
		return nil, err
	}
	return selectionValuesFromFields(fields, screen), nil
}

func graphicalForm(s *abap.Session, report ZIF_GG_REPORT_V1, screen ZCL_GG_HOST__TY_RESULT) termgui.Form {
	current := map[string]selectionInput{}
	for _, v := range screen.values {
		current[strings.TrimSpace(v.name)] = selectionInput{value: strings.TrimSpace(v.value), ranges: v.ranges}
	}
	form := termgui.Form{Title: appProgram + " — selection screen"}
	for _, e := range screen.elements {
		name := strings.TrimSpace(e.name)
		if name == "" || (e.kind != "PARAMETER" && e.kind != "CHECKBOX" && e.kind != "SELECT_OPTION") {
			continue
		}
		input := current[name]
		field := termgui.Field{Name: name, Label: strings.TrimSpace(e.text), Value: input.value, Width: int(e.visible_length)}
		switch e.kind {
		case "CHECKBOX":
			field.Kind = termgui.Checkbox
		case "SELECT_OPTION":
			field.Kind = termgui.Ranges
			parts := make([]string, 0, len(input.ranges))
			for _, r := range input.ranges {
				parts = append(parts, strings.TrimSpace(r.low))
			}
			field.Value = strings.Join(parts, ",")
		default:
			field.Kind = termgui.Text
		}
		form.Fields = append(form.Fields, field)
		if e.kind == "SELECT_OPTION" && appF4[name+"-HIGH"] {
			high := ""
			if len(input.ranges) > 0 {
				high = strings.TrimSpace(input.ranges[0].high)
			}
			form.Fields = append(form.Fields, termgui.Field{Name: name + "-HIGH", Label: strings.TrimSpace(e.text) + " high", Value: high, Width: int(e.visible_length)})
		}
	}
	form.OnF4 = func(terminal tcell.Screen, name string, fields []termgui.Field) (string, error) {
		target := name
		if appRanges[name] {
			target += "-LOW"
		}
		if !appF4[target] {
			return "", fmt.Errorf("no ON VALUE-REQUEST for %s", name)
		}
		original := ""
		for _, f := range fields {
			if f.Name == name {
				original = f.Value
			}
		}
		var pickErr error
		abap.FrontendPick = func(options abap.FrontendPickOptions) (string, error) {
			browser := browserForDialog(options)
			path, err := browser.Run(terminal)
			if errors.Is(err, filepick.ErrCancel) {
				return "", abap.ErrFrontendPickCancel
			}
			if err != nil {
				pickErr = err
			}
			return path, err
		}
		defer func() { abap.FrontendPick = nil }()
		var result ZCL_GG_HOST__TY_RESULT
		abap.DialogStep(func() { result = hostRunRequest(s, report, selectionValuesFromFields(fields, screen), "", "X", target) })
		if pickErr != nil {
			return "", pickErr
		}
		base := strings.SplitN(target, "-", 2)[0]
		for _, v := range result.values {
			if strings.TrimSpace(v.name) == base && len(v.ranges) > 0 {
				if strings.HasSuffix(target, "-HIGH") {
					return strings.TrimSpace(v.ranges[0].high), nil
				}
				if appRanges[base] {
					lows := make([]string, 0, len(v.ranges))
					for _, r := range v.ranges {
						lows = append(lows, strings.TrimSpace(r.low))
					}
					return strings.Join(lows, ","), nil
				}
				return strings.TrimSpace(v.ranges[0].low), nil
			}
		}
		return original, nil
	}
	return form
}

func browserForDialog(options abap.FrontendPickOptions) filepick.Browser {
	mode := filepick.Open
	switch options.Kind {
	case "save":
		mode = filepick.Save
	case "directory":
		mode = filepick.Directory
	}
	// The generated call passes "" when PROMPT_ON_OVERWRITE is omitted;
	// SAP's documented default is X. An explicit space disables the prompt.
	sb := dialogSandbox
	if sb == nil {
		sb = abap.SandboxFromEnv()
	}
	return filepick.Browser{Sandbox: sb, Mode: mode, Initial: options.Initial, DefaultName: options.Name, Title: options.Title, Multi: options.Kind == "open-multiple", Patterns: filepick.SAPPatterns(options.Filter), Extension: options.Extension, ConfirmOverwrite: options.Kind == "save" && (options.Prompt == "" || strings.EqualFold(strings.TrimSpace(options.Prompt), "X"))}
}

func selectionValuesFromFields(fields []termgui.Field, screen ZCL_GG_HOST__TY_RESULT) []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE {
	current := map[string]selectionInput{}
	for _, v := range screen.values {
		current[strings.TrimSpace(v.name)] = selectionInput{value: strings.TrimSpace(v.value), ranges: v.ranges}
	}
	for _, field := range fields {
		if field.Kind == termgui.Ranges {
			input := current[field.Name]
			previous := input.ranges
			input.ranges = nil
			if strings.TrimSpace(field.Value) != "" {
				for i, value := range strings.Split(field.Value, ",") {
					r := ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{sign: "I", option: "EQ"}
					if i < len(previous) {
						r = previous[i]
					}
					r.low = strings.TrimSpace(value)
					input.ranges = append(input.ranges, r)
				}
			}
			current[field.Name] = input
		} else if strings.HasSuffix(field.Name, "-HIGH") && appRanges[strings.TrimSuffix(field.Name, "-HIGH")] {
			base := strings.TrimSuffix(field.Name, "-HIGH")
			input := current[base]
			if len(input.ranges) == 0 && field.Value != "" {
				input.ranges = append(input.ranges, ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{sign: "I", option: "BT"})
			}
			if len(input.ranges) > 0 {
				input.ranges[0].high = field.Value
				if field.Value != "" {
					input.ranges[0].option = "BT"
				} else if input.ranges[0].option == "BT" {
					input.ranges[0].option = "EQ"
				}
			}
			current[base] = input
		} else {
			current[field.Name] = selectionInput{value: field.Value}
		}
	}
	return selectionValues(current)
}

func commandInput(cli reportargs.Result) ([]ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, bool) {
	values := map[string]selectionInput{}
	params := ""
	for _, flag := range cli.Host {
		if flag.Name == "params" {
			params = flag.Value
		}
	}
	for _, option := range cli.Options {
		value := option.Value
		if !option.HasValue && appCheckboxes[option.Name] {
			value = "X"
		}
		setOption(values, option.Name, value)
	}
	positionals := cli.Positionals
	if params != "" {
		raw := []byte(params)
		if strings.HasPrefix(params, "@") {
			var err error
			raw, err = os.ReadFile(strings.TrimPrefix(params, "@"))
			if err != nil {
				panic(err)
			}
		}
		fromJSON := map[string]any{}
		if err := json.Unmarshal(raw, &fromJSON); err != nil {
			panic(fmt.Errorf("-params: %w", err))
		}
		for key, rawValue := range fromJSON {
			name, checkbox := selectionName(key)
			if name == "" {
				panic(fmt.Errorf("-params: unknown selection field %s", key))
			}
			if appRanges[name] {
				if _, setByFlag := values[name]; !setByFlag {
					values[name] = selectionInput{ranges: jsonRanges(name, rawValue)}
				}
				continue
			}
			value := fmt.Sprint(rawValue)
			if checkbox {
				if b, ok := rawValue.(bool); ok {
					if b {
						value = "X"
					} else {
						value = ""
					}
				}
			}
			if _, setByFlag := values[name]; !setByFlag {
				values[name] = selectionInput{value: value}
			}
		}
	}
	for i, arg := range positionals {
		if i >= len(appPositionals) {
			panic(fmt.Errorf("unexpected positional argument %q", arg))
		}
		values[appPositionals[i]] = selectionInput{value: arg}
	}
	return selectionValues(values), len(cli.Options) > 0 || len(cli.Positionals) > 0 || params != ""
}

func selectionName(option string) (string, bool) {
	want := strings.ToUpper(strings.ReplaceAll(option, "-", "_"))
	for _, name := range appSelectionNames {
		short := strings.TrimPrefix(name, "P_")
		if want == name || want == short {
			return name, appCheckboxes[name]
		}
	}
	return "", false
}

type selectionInput struct {
	value  string
	ranges []ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE
}

func setOption(values map[string]selectionInput, name, value string) {
	if appRanges[name] {
		input := values[name]
		input.ranges = append(input.ranges, ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{sign: "I", option: "EQ", low: value})
		values[name] = input
		return
	}
	values[name] = selectionInput{value: value}
}

func jsonRanges(name string, raw any) []ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE {
	items, ok := raw.([]any)
	if !ok {
		items = []any{raw}
	}
	out := make([]ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE, 0, len(items))
	for _, item := range items {
		r := ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{sign: "I", option: "EQ"}
		if object, ok := item.(map[string]any); ok {
			fields := map[string]string{}
			for key, value := range object {
				fields[strings.ToUpper(key)] = fmt.Sprint(value)
			}
			r.sign = strings.ToUpper(fields["SIGN"])
			if r.sign == "" {
				r.sign = "I"
			}
			r.option = strings.ToUpper(fields["OPTION"])
			r.low, r.high = fields["LOW"], fields["HIGH"]
			if r.option == "" {
				if r.high != "" {
					r.option = "BT"
				} else {
					r.option = "EQ"
				}
			}
		} else {
			r.low = fmt.Sprint(item)
		}
		if r.low == "" && r.option != "EQ" {
			panic(fmt.Errorf("-params: %s range needs low", name))
		}
		out = append(out, r)
	}
	return out
}

func usage() {
	fmt.Printf("usage: %s", strings.ToLower(appProgram))
	for _, name := range appPositionals {
		fmt.Printf(" <%s>", strings.ToLower(strings.TrimPrefix(name, "P_")))
	}
	fmt.Println(" [--report options] [-host flags]")
	fmt.Println("report options (the selection screen; also by full name, --p-name / --s-name):")
	for _, name := range appSelectionNames {
		opt := strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(name, "P_"), "_", "-"))
		kind := "value"
		if appRanges[name] {
			kind = "range (repeatable)"
		} else if appCheckboxes[name] {
			kind = "checkbox"
		}
		if label := appLabels[name]; label != "" {
			// the selection text of the report, as the selection screen shows it
			fmt.Printf("  --%-16s %s (%s, %s)\n", opt, label, name, kind)
		} else {
			fmt.Printf("  --%-16s %s %s\n", opt, name, kind)
		}
	}
	fmt.Println("  --                 everything after is positional")
	fmt.Println("host flags (one dash):")
	if len(appTables) > 0 {
		fmt.Printf("  -db FILE           keep the rows of %s in the SQLite FILE (created when missing)\n", strings.Join(appTables, ", "))
	}
	fmt.Println("  -params JSON|@file  the selection screen as JSON")
	fmt.Printf("default read parameters: %s; list parameters: %s\n", strings.Join(appReadParams, ", "), strings.Join(appReadLists, ", "))
	fmt.Println("  -no-default-reads   disable reads granted from user parameter values")
	fmt.Println("  -allow-read DIR     allow DATASET reads within DIR (repeatable)")
	fmt.Println("  -allow-write DIR    allow DATASET writes within DIR (repeatable; also readable)")
	fmt.Println("  -dataset-home DIR   base for relative DATASET names")
	fmt.Println("  -dataset-audit FILE append OPEN/DELETE decisions inside a write root")
	fmt.Println("  -sapgui[=ADDR]      launch SAP GUI and serve it the selection screen (default 127.0.0.1:3232)")
	fmt.Println("  -sapgui-no-launch   serve SAP GUI without launching a local client")
	fmt.Println("  -help               this text")
}

func selectionValues(values map[string]selectionInput) []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE {
	out := make([]ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE, 0, len(values))
	for _, name := range appSelectionNames {
		if input, ok := values[name]; ok {
			out = append(out, ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE{name: name, value: input.value, ranges: input.ranges})
		}
	}
	return out
}

func terminalInput(screen ZCL_GG_HOST__TY_RESULT) []ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE {
	current := map[string]selectionInput{}
	for _, v := range screen.values {
		current[strings.TrimSpace(v.name)] = selectionInput{value: strings.TrimSpace(v.value), ranges: v.ranges}
	}
	fmt.Printf("\n%s — selection screen\n\n", appProgram)
	in := bufio.NewReader(os.Stdin)
	for _, e := range screen.elements {
		name := strings.TrimSpace(e.name)
		if name == "" || (e.kind != "PARAMETER" && e.kind != "CHECKBOX" && e.kind != "SELECT_OPTION") {
			continue
		}
		input := current[name]
		def := input.value
		if appRanges[name] {
			parts := make([]string, 0, len(input.ranges))
			for _, r := range input.ranges {
				parts = append(parts, strings.TrimSpace(r.low))
			}
			def = strings.Join(parts, ",")
		}
		fmt.Printf("%-18s [%s]: ", strings.TrimSpace(e.text), def)
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			if appRanges[name] {
				input.ranges = nil
				for _, value := range strings.Split(line, ",") {
					input.ranges = append(input.ranges, ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{sign: "I", option: "EQ", low: strings.TrimSpace(value)})
				}
				current[name] = input
				continue
			}
			if e.kind == "CHECKBOX" {
				if strings.EqualFold(line, "y") || strings.EqualFold(line, "yes") || line == "1" || strings.EqualFold(line, "true") {
					line = "X"
				} else {
					line = ""
				}
			}
			current[name] = selectionInput{value: line}
		}
	}
	fmt.Println()
	return selectionValues(current)
}

// dbOption takes -db FILE: the SQLite file a report with tables of its own
// keeps its rows in, created with the report's tables when it is missing
// (abap.OpenDBFile, which refuses a file another build laid out). A report
// with no tables has no database and refuses the flag; one with tables and
// no -db has no database either, and its first statement says so.
func dbOption(host []reportargs.Arg) {
	path := ""
	for _, flag := range host {
		if flag.Name == "db" {
			path = flag.Value
		}
	}
	if path == "" {
		return
	}
	if len(appTables) == 0 {
		panic(fmt.Errorf("-db: %s has no tables of its own", appProgram))
	}
	// the path goes into a file: URI, where these would be read as its syntax
	// (a '?' would cut the name short and create another file)
	if strings.ContainsAny(path, "?#%") {
		panic(fmt.Errorf("-db %s: a file name with ?, # or %% is not accepted", path))
	}
	if _, err := abap.OpenDBFile(path, appSchema); err != nil {
		panic(fmt.Errorf("-db %s: %w", path, err))
	}
	dbOpen = true
}

var dbOpen bool

// closeDB checkpoints the -db file: the last connection closing folds the
// WAL back into it, so the file alone holds every row
func closeDB() {
	if dbOpen {
		dbOpen = false
		if err := abap.DB().Close(); err != nil {
			fmt.Fprintln(os.Stderr, "osabap: closing the -db file:", err)
		}
	}
}

// withoutDB names the way out when a report with tables ran without -db:
// the runtime only knows that no database was opened
func withoutDB(r any) any {
	if len(appTables) > 0 && strings.Contains(fmt.Sprint(r), "the host did not open a database") {
		return fmt.Sprintf("%s keeps its rows in tables (%s): run it with -db FILE", strings.ToLower(appProgram), strings.Join(appTables, ", "))
	}
	return r
}
