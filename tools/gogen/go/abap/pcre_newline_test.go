package abap

import (
	"fmt"
	"strings"
	"testing"
)

func TestPCRELineEnds(t *testing.T) {
	cds := "\ndefine root view entity zi_lockentity as select from zfoo {\n  key field1\n}"
	for _, c := range []struct {
		s, p, replacement, want, spans string
		rc                             int32
	}{
		{"WHEN &1.\n", "&1", "'a'", "WHEN 'a'.\n", "1[5,2;]", 0},
		{cds, "\u00a0", " ", cds, "0[]", 4},
		{"a\n\ra", `[^a]+`, "X", "aXa", "1[1,2;]", 0},
		{"a \n\r\tb", `\s+`, "X", "aXb", "1[1,4;]", 0},
		{"a.b\n", `\.`, "X", "aXb\n", "1[1,1;]", 0},
		{"^$\n", `\^\$`, "X", "X\n", "1[0,2;]", 0},
		{"x\r\n12", `\b\d+\b`, "X", "x\r\nX", "1[3,2;]", 0},
		{"\nx", `\w+`, "X", "\nX", "1[1,1;]", 0},
		{"\n.^$", `[.^$]+`, "X", "\nX", "1[1,3;]", 0},
	} {
		if got := fmtRes(FindResults(c.s, c.p, 'P', false, true)); got != c.spans {
			t.Errorf("%q: %s want %s", c.p, got, c.spans)
		}
		if got, rc := ReplaceStmt(c.s, c.p, c.replacement, true, true, false, 0, NoLength, -1, true); got != c.want || rc != c.rc {
			t.Errorf("%q: %q/%d want %q/%d", c.p, got, rc, c.want, c.rc)
		}
	}
	for _, p := range []string{`^x`, `x$`, `a.b`, `\\.`, `\A^x`, `x$\z`} {
		for _, run := range []func(){
			func() { FindResults("x\na.b", p, 'P', false, true) },
			func() { ReplaceStmt("x\na.b", p, "X", true, true, false, 0, NoLength, -1, true) },
		} {
			func() {
				defer func() {
					if e := fmt.Sprint(recover()); e != "NOT_COMPILED in FIND PCRE: a text with line ends: PCRE's ^ $ and . around them are not measured" {
						t.Errorf("%q: %s", p, e)
					}
				}()
				run()
			}()
		}
	}
}

func TestPCREGenericTypes(t *testing.T) {
	for _, c := range []struct {
		p, s  string
		icase bool
		want  string
	}{
		{"\\s+", "\n ", false, "X "},
		{"\\s+", "\n\v", false, "X"},
		{"\\S+", "\n ", false, "\nX"},
		{"[^\\s]+", "\n ", false, "\nX"},
		{"[\\s\\d]+", "\n\v12 ", false, "X "},
		{"[\\S\\d]+", "\n 12", false, "\nX"},
		{"[^\\S\\d]+", "\n 12", false, "X 12"},
		{"\\w+", "ſKK", true, "ſKX"},
		{"[\\w]+", "ſKK", true, "ſKX"},
		{"[^\\w]+", "ſKK", true, "XK"},
		{"[\\wſ]+", "ſKK", true, "XKX"},
		{"\\W+", "ſKK", true, "XK"},
		{"\\d+", "١1", true, "١X"},
		{"\\D+", "١1", true, "X1"},
		{"\\bK\\b", " K ", true, " X "},
		{"\\b", "ſKK", true, "ſXKXK"},
		{"\\B", "ſKK", true, "XſKKX"},
		{"\\\\s", "\\s", false, "X"},
		{"[\\\\s]+", "\\s", false, "X"},
		{"\\s # \\w\n +", "\n\v", false, "X"},
	} {
		got, rc := ReplaceStmt(c.s, c.p, "X", true, true, c.icase, 0, NoLength, -1, true)
		if got != c.want || rc != 0 {
			t.Errorf("%q: %q/%d want %q/0", c.p, got, rc, c.want)
		}
	}
}

func TestPCREGenericSpaceAndEscapes(t *testing.T) {
	extra := "\u00a0\ufeff\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
	for _, icase := range []bool{false, true} {
		for _, p := range []string{`\s+`, `[\s]+`, `[^\S]+`} {
			got, rc := ReplaceStmt("\t\n\v\f\r "+extra, p, "X", true, true, icase, 0, NoLength, -1, true)
			if got != "X"+extra || rc != 0 {
				t.Errorf("%s: %q/%d", p, got, rc)
			}
		}
		for _, p := range []string{`\S+`, `[^\s]+`, `[\S]+`} {
			got, rc := ReplaceStmt("\t\n\v\f\r "+extra, p, "X", true, true, icase, 0, NoLength, -1, true)
			if got != "\t\n\v\f\r X" || rc != 0 {
				t.Errorf("%s: %q/%d", p, got, rc)
			}
		}
	}
	for _, c := range [][2]string{{`[\b]+`, "\b\b"}, {`\\Q`, `\Q`}, {`[\-\s]+`, "-\v"}} {
		if got := fmtRes(FindResults(c[1], c[0], 'P', true, true)); got != "1[0,2;]" {
			t.Errorf("%s: %s", c[0], got)
		}
	}
	for _, p := range []string{`[a-\s]`, `[\w-z]`, `[\B]`} {
		func() {
			defer func() {
				if e := fmt.Sprint(recover()); !strings.Contains(e, "NOT_COMPILED in FIND PCRE") {
					t.Errorf("%s: %s", p, e)
				}
			}()
			FindResults("a", p, 'P', false, true)
		}()
	}
}
