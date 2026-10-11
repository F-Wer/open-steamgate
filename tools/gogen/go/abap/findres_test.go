package abap

import (
	"fmt"
	"strings"
	"testing"
)

func fmtRes(ms [][]int32) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d[", len(ms))
	for _, m := range ms {
		fmt.Fprintf(&b, "%d,%d", m[0], m[1])
		for g := 2; g+1 < len(m); g += 2 {
			fmt.Fprintf(&b, "(%d,%d)", m[g], m[g+1])
		}
		b.WriteString(";")
	}
	return b.String() + "]"
}

// A4H 2026-09-25, ZCL_GOGEN_T_FINDRES / _FINDPCRE
func TestFindResults(t *testing.T) {
	for _, c := range []struct {
		s, p       string
		kind       byte
		icase, all bool
		want       string
	}{
		{"xabab", "a|ab", 'R', false, true, "2[1,2;3,2;]"},
		{"xb", "(a)|(b)", 'R', false, false, "1[1,1(-1,0)(1,1);]"},
		{"abab", "((a)(b))", 'R', false, true, "2[0,2(0,2)(0,1)(1,1);2,2(2,2)(2,1)(3,1);]"},
		{"ab cab ab", `\bab\b`, 'R', false, true, "2[0,2;7,2;]"},
		{"aaaaa", "aa", 0, false, true, "2[0,2;2,2;]"},
		{"xAbab", "AB", 'R', true, true, "2[1,2;3,2;]"},
		{"aébé", "b", 0, false, true, "1[2,1;]"},
		{"abd", "b(c)?", 'R', false, false, "1[1,1(-1,0);]"},
		{"aab", "a(b)?", 'R', false, true, "2[0,1(-1,0);1,2(2,1);]"},
		{"abc", "zz", 0, false, true, "0[]"},
		{"abc", "x*", 'R', false, true, "4[0,0;1,0;2,0;3,0;]"},
		{"abbc", "b*", 'R', false, true, "4[0,0;1,2;3,0;4,0;]"},
		{"one two", `(\w+)`, 'R', false, true, "2[0,3(0,3);4,3(4,3);]"},
		{"abcd", "(a|ab)(c|bcd)", 'R', false, true, "1[0,4(0,1)(1,3);]"},
		{"xabab", "a|ab", 'P', false, true, "2[1,1;3,1;]"},
		{"abcd", "(a|ab)(c|bcd)", 'P', false, true, "1[0,4(0,1)(1,3);]"},
		{"abbc", "b*", 'P', false, true, "4[0,0;1,2;3,0;4,0;]"},
		{"ab cab ab", `\bab\b`, 'P', false, true, "2[0,2;7,2;]"},
		{"ab", "(x)?b", 'P', false, true, "1[1,1(-1,0);]"},
		{"aaa", "a+?", 'P', false, true, "3[0,1;1,1;2,1;]"},
		{"xAbab", "AB", 'P', true, true, "2[1,2;3,2;]"},
	} {
		if got := fmtRes(FindResults(c.s, c.p, c.kind, c.icase, c.all)); got != c.want {
			t.Errorf("%q in %q (%c): %s, A4H %s", c.p, c.s, c.kind, got, c.want)
		}
	}
	for _, p := range []string{"(?=a)", "(?<=a)b", `(a)\1`, "a++", "(?>a)"} {
		func() {
			defer func() {
				if e, ok := recover().(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
					t.Errorf("%s: not refused by name: %v", p, e)
				}
			}()
			FindResults("aab", p, 'P', false, true)
		}()
	}
}

// Unmeasured regressions: statement adapters must retain mode P's refusal.
func TestPlainPCRERefusals(t *testing.T) {
	for _, p := range []string{"a(?=b)", "(?<=a)b", `(a)\1`, "a++", "(?>a)", `\K`, "(", "(?i)a", "(?-x:a)", "a(?-x)b"} {
		refusal := func(run func()) any {
			var err any
			func() { defer func() { err = recover() }(); run() }()
			return err
		}
		want := refusal(func() { FindResults("aab", p, 'P', false, true) })
		if want == nil {
			t.Fatalf("%q was not refused", p)
		}
		for _, run := range []func(){
			func() { FindStmt("aab", p, true, false, 0, true) },
			func() { FindAllCount("aab", p, true, false, true) },
			func() { ReplaceStmt("aab", p, "x", true, true, false, 0, NoLength, -1, true) },
		} {
			if got := refusal(run); fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("%q: refusal %v, RESULTS %v", p, got, want)
			}
		}
	}
}

func TestPCREReplacementSpans(t *testing.T) {
	for _, c := range []struct {
		s, p, with, want string
		all              bool
	}{
		{"éaab", "(a+?)b", "$1!", "éaa!", false},
		{"abbc", "b*", "X", "XaXXcX", true},
		{"abab", `(a)(b)`, "$2$1", "baba", true},
		{"xxaab", "z", "X", "xxaab", true},
	} {
		got, _ := ReplaceStmt(c.s, c.p, c.with, true, c.all, false, 0, NoLength, -1, true)
		if got != c.want {
			t.Errorf("%q / %q: %q, want %q", c.s, c.p, got, c.want)
		}
	}
}

func TestRegexUTF16Spans(t *testing.T) {
	for _, pcre := range []bool{false, true} {
		for _, c := range []struct {
			s, p, sub string
			off, n    int32
		}{
			{"😀a", "(a)", "a", 2, 1}, {"😀", "(.)", "😀", 0, 2},
		} {
			ok, off, n, subs := FindStmt(c.s, c.p, true, false, 1, pcre)
			if !ok || off != c.off || n != c.n || subs[0] != c.sub {
				t.Errorf("spans: %v %v %v %v", ok, off, n, subs)
			}
		}
		kind := byte('R')
		if pcre {
			kind = 'P'
		}
		if got := fmtRes(FindResults("😀a", "(.)", kind, false, true)); got != "2[0,2(0,2);2,1(2,1);]" {
			t.Fatal(got)
		}
		for _, c := range []struct {
			off, ln int32
			cLen    int
			want    string
			rc      int32
		}{
			{0, NoLength, -1, "😀a!", 0}, {2, 1, -1, "😀a!", 0}, {0, NoLength, 3, "😀a", 2},
		} {
			got, rc := ReplaceStmt("😀a", "(a)", "$1!", true, false, false, c.off, c.ln, c.cLen, pcre)
			if got != c.want || rc != c.rc {
				t.Errorf("replace: %q/%d want %q/%d", got, rc, c.want, c.rc)
			}
		}
	}
}

// Unmeasured: ABAP PCRE extended mode by documentation; measure on A4H before changing
func TestPCREExtended(t *testing.T) {
	for _, c := range []struct {
		p, s  string
		found bool
		n     int32
	}{
		{"a b", "ab", true, 2}, {`a\ b`, "a b", true, 3}, {"[ ]", " ", true, 1},
		{"a # ignored (?i)\\K\n b", "ab", true, 2}, {`a\#b`, "a#b", true, 3},
		{"(?-x)a b", "a b", true, 3}, {"(?-x)a b", "ab", false, 0}, {"[ #]", "#", true, 1},
		{"[^] #]", "#", false, 0}, {"[^] #]", "a", true, 1}, {"[] #]", "]", true, 1},
		{"[[:alpha:] #]", "#", true, 1}, {"[[:alpha:] #]", " ", true, 1}, {"[[:alpha:] #]", "a", true, 1},
		{"[[:space:] #]", "\t", true, 1}, {"[[:ascii:] #]", "a", true, 1}, {"[[:punct:] #]", "]", true, 1},
		{"a\tb", "ab", true, 2}, {"[(?i)]", "i", true, 1}, {`\(\?i\)`, "(?i)", true, 4},
	} {
		ok, off, n, _ := FindStmt(c.s, c.p, true, false, 0, true)
		if ok != c.found || off != 0 || n != c.n {
			t.Errorf("%q: %v/%d/%d", c.p, ok, off, n)
		}
		want := 0
		if c.found {
			want = 1
		}
		if len(FindResults(c.s, c.p, 'P', false, false)) != want {
			t.Errorf("RESULTS %q", c.p)
		}
		got, rc := ReplaceStmt(c.s, c.p, "X", true, false, false, 0, NoLength, -1, true)
		with, subrc := c.s, int32(4)
		if c.found {
			with, subrc = "X", 0
		}
		if got != with || rc != subrc {
			t.Errorf("REPLACE %q: %q/%d", c.p, got, rc)
		}
	}
}

func TestPCREReplacementEscapes(t *testing.T) {
	for _, with := range []string{`\U$0`, `\L$0`, `\E`, `\u$1`, `\l$1`, `\n`, `\q`, `\`} {
		for _, s := range []string{"ab", "miss"} {
			func() {
				defer func() {
					e, ok := recover().(ArithmeticError)
					if !ok || e.Class != "NOT_COMPILED" || !strings.Contains(fmt.Sprint(e), "unsupported replacement escape") {
						t.Errorf("%q: %v", with, e)
					}
				}()
				ReplaceStmt(s, "(ab)", with, true, false, false, 0, NoLength, -1, true)
			}()
		}
	}
	for _, c := range []struct{ with, want string }{{"$0/$1/$9", "ab/ab/"}, {`\\\$$1`, `\$ab`}, {"$&", "ab"}} {
		got, rc := ReplaceStmt("ab", "(ab)", c.with, true, false, false, 0, NoLength, -1, true)
		if got != c.want || rc != 0 {
			t.Errorf("%q: %q/%d", c.with, got, rc)
		}
	}
	// ${n} remains refused, as on the REGEX replacement path.
	for _, pcre := range []bool{false, true} {
		func() {
			defer func() {
				e, ok := recover().(ArithmeticError)
				if !ok || e.Class != "NOT_COMPILED" {
					t.Errorf("${1}: %v", e)
				}
			}()
			ReplaceStmt("ab", "(ab)", "${1}", true, false, false, 0, NoLength, -1, pcre)
		}()
	}
}

// Unmeasured: fixed character fields count UTF-16 units, including padding.
func TestRegexUTF16Padding(t *testing.T) {
	for _, pcre := range []bool{false, true} {
		for _, c := range []struct {
			s, want string
			rc      int32
		}{{"😀a", "😀a", 4}, {"😀", "😀X", 0}} {
			got, rc := ReplaceStmt(c.s, "[ ]", "X", true, false, false, 0, NoLength, 3, pcre)
			if got != c.want || rc != c.rc {
				t.Errorf("pcre=%v: %q/%d want %q/%d", pcre, got, rc, c.want, c.rc)
			}
		}
	}
}

// Unmeasured: Round 3 patterns are refused consistently rather than translated.
func TestPCREQuotingAndNegatedPOSIXRefusals(t *testing.T) {
	for _, c := range []struct{ p, reason string }{
		{`[\Q\E^] #]`, `unsupported quoting escape \Q`},
		{`[\Q\E] #]`, `unsupported quoting escape \Q`},
		{`\Qa b\E`, `unsupported quoting escape \Q`},
		{`\E`, `unsupported quoting escape \E`},
		{`[[:^alpha:] #]`, "an unsupported POSIX class: ^alpha"},
	} {
		for _, run := range []func(){
			func() { FindResults("#", c.p, 'P', false, true) },
			func() { FindStmt("#", c.p, true, false, 0, true) },
			func() { FindAllCount("#", c.p, true, false, true) },
			func() { ReplaceStmt("#", c.p, "X", true, true, false, 0, NoLength, -1, true) },
		} {
			func() {
				defer func() {
					if e := recover(); fmt.Sprint(e) != "NOT_COMPILED in FIND PCRE: "+c.reason {
						t.Errorf("%q: %v", c.p, e)
					}
				}()
				run()
			}()
		}
	}
}
