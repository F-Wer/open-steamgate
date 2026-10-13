package abap

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// Unmeasured; measure on A4H. Shared PCRE scanner and UTF-16 statement spans.
func TestPCREHex(t *testing.T) {
	for _, c := range []struct {
		p, text string
		off, n  int32
	}{
		{`\xA0`, "😀\u00a0", 2, 1},
		{`[\x00-\x1F\xA0]`, "😀\u00a0", 2, 1},
		{`[\x00-\x1F\xA0]`, "a\x1f", 1, 1},
		{`[\x4]`, "a\x04", 1, 1},
		{`[\x{263A}]`, "a☺", 1, 1},
		{`\x41`, "😀A", 2, 1}, {`\x4`, "a\x04", 1, 1},
		{`\x414`, "aA4", 1, 2},
		{`\x{263A}`, "a☺", 1, 1}, {`\x{1F600}`, "a😀", 1, 2},
		{`[\x{1F600}-\x{1F601}]`, "a😁", 1, 2},
		{`\x{000000000000001F600}+`, "a😀😀", 1, 4},
		{`\x{10FFFF}`, "a\U0010ffff", 1, 2},
		{`\\x41`, `a\x41`, 1, 4}, {`[\\x41]+`, `a\x41`, 1, 4},
		{`\x4 1`, "a\x041", 1, 2},
		{`\x23\x20\x5B\x5C`, "a# [\\", 1, 4},
		{`\A\x41\z`, "A", 0, 1}, {`\x41 # \x{D800}`, "A", 0, 1},
	} {
		t.Run(c.p, func(t *testing.T) {
			want := [][]int32{{c.off, c.n}}
			if got := FindResults(c.text, c.p, 'P', false, true); !reflect.DeepEqual(got, want) {
				t.Fatalf("RESULTS %v want %v", got, want)
			}
			ok, off, n, _ := FindStmt(c.text, c.p, true, false, 0, true)
			if !ok || off != c.off || n != c.n {
				t.Fatalf("FIND %v/%d/%d", ok, off, n)
			}
			if got := FindAllCount(c.text, c.p, true, false, true); got != 1 {
				t.Fatalf("COUNT %d", got)
			}
			wantText := SubS(c.text, 0, c.off) + "X" + SubS(c.text, c.off+c.n, Strlen(c.text)-c.off-c.n)
			for _, all := range []bool{false, true} {
				got, rc := ReplaceStmt(c.text, c.p, "X", true, all, false, 0, NoLength, -1, true)
				if got != wantText || rc != 0 {
					t.Fatalf("REPLACE %q/%d want %q/0", got, rc, wantText)
				}
			}
		})
	}
	if got := FindResults("😀A😀", `(\x{1F600})`, 'P', false, true); !reflect.DeepEqual(got, [][]int32{{0, 2, 0, 2}, {3, 2, 3, 2}}) {
		t.Fatal(got)
	}
}

func TestPCREHexRefusals(t *testing.T) {
	for _, c := range []struct{ p, reason string }{
		{`\x{D800}`, "a surrogate hex escape"}, {`[\x{DFFF}]`, "a surrogate hex escape"},
		{`\x{110000}`, "a hex escape above U+10FFFF"},
		{`\x{FFFFFFFFFFFFFFFFFFFFFFFF}`, "a hex escape above U+10FFFF"},
		{`\x{}`, "a malformed braced hex escape"}, {`\x{41`, "a malformed braced hex escape"},
		{`\x{4G}`, "a malformed braced hex escape"},
		{`\x41++`, "a possessive quantifier"},
		{`\u{41}+`, "a possessive quantifier is not in Go's RE2: \\u{41}+"},
		{`\u0041`, "RE2 does not read this pattern (error parsing regexp: invalid escape sequence: `\\u`); whether PCRE does is not measured"},
		{`\x`, `\x without hex digits`},
		{`[\x]`, `\x without hex digits`},
		{`\xg`, `\x without hex digits`},
		{`\x 41`, `\x without hex digits`},
		{`\x\x11`, `\x without hex digits`},
	} {
		for _, run := range []func(){
			func() { FindResults("A", c.p, 'P', false, true) },
			func() { FindStmt("A", c.p, true, false, 0, true) },
			func() { FindAllCount("A", c.p, true, false, true) },
			func() { ReplaceStmt("A", c.p, "X", true, true, false, 0, NoLength, -1, true) },
		} {
			func() {
				defer func() {
					if e := fmt.Sprint(recover()); !strings.Contains(e, "NOT_COMPILED in FIND PCRE: "+c.reason) {
						t.Errorf("%s: %s", c.p, e)
					}
				}()
				run()
			}()
		}
	}
	for _, escape := range `ceoNXRhHvV` {
		func() {
			defer func() {
				if e := recover(); e == nil {
					t.Errorf("escape %c accepted", escape)
				}
			}()
			FindResults("a", `\`+string(escape), 'P', false, true)
		}()
	}
}
