package abap

import (
	"fmt"
	"strings"
	"testing"
)

// Expected spans are subject-absolute PCRE semantics, independently checked by
// Node RegExp with u/s in frontend-bytes.test.mjs (including empty subjects).
func TestPCRELookaroundAnchors(t *testing.T) {
	for _, pair := range []string{`\s\S`, `\S\s`, `\d\D`, `\D\d`, `\w\W`, `\W\w`} {
		start, end := "(?<!["+pair+"])", "(?!["+pair+"])"
		for _, c := range []struct{ s, p, want, replaced string }{
			{"abab", start + "ab", "1[0,2;]", "Xab"},
			{"abab", "ab" + end, "1[2,2;]", "abX"},
			{"ab\nab", start + "ab", "1[0,2;]", "X\nab"},
			{"ab\nab", "ab" + end, "1[3,2;]", "ab\nX"},
			{"ab\n", "ab" + end, "0[]", "ab\n"},
			{"", start + end, "1[0,0;]", "X"},
			{"ab\n", start, "1[0,0;]", "Xab\n"},
			{"ab\n", end, "1[3,0;]", "ab\nX"},
			{"Ab", start + "ab" + end, "1[0,2;]", "X"},
			{"ab", "(?:" + start + "ab)", "1[0,2;]", "X"},
		} {
			for _, ic := range []bool{false, true} {
				if c.s == "Ab" && !ic {
					continue
				}
				if got := fmtRes(FindResults(c.s, c.p, 'P', ic, true)); got != c.want {
					t.Errorf("%q %q: %s want %s", c.s, c.p, got, c.want)
				}
				for _, all := range []bool{false, true} {
					got, _ := ReplaceStmt(c.s, c.p, "X", true, all, ic, 0, NoLength, -1, true)
					if got != c.replaced {
						t.Errorf("replace %q %q: %q", c.s, c.p, got)
					}
					first := FindResults(c.s, c.p, 'P', ic, all)
					if fmtRes(first) != c.want {
						t.Errorf("first/all %q: %v", c.p, first)
					}
				}
			}
		}
		// The continuation pattern consumes the preceding character. Absolute start
		// must never reset at that character, even on a sliced continuation subject.
		for _, s := range []string{"ab", "\nab", "😀ab"} {
			_, after := compilePCRE(start+"ab", false, s)
			for pos := 1; pos < len(s); pos++ {
				if after.MatchString(s[pos-1:]) {
					t.Errorf("after start %q at %d", s, pos)
				}
			}
			_, after = compilePCRE("ab"+end, false, s)
			if !after.MatchString("xab") {
				t.Error("after end did not match")
			}
		}
	}
	for _, p := range []string{`\(?<![\s\S])`, `[(?<![\s\S])]`, `\(?![\s\S])`, `[(?![\s\S])]`} {
		// Class serialization can change spelling, but must introduce no anchors.
		got := extendedPCRE(p)
		if strings.Contains(got, `\A`) || strings.Contains(got, `\z`) {
			t.Errorf("literal changed: %q -> %q", p, got)
		}
	}
	if got := extendedPCRE("ab # (?<![\\s\\S]) (?![\\s\\S])\n"); got != "ab" {
		t.Fatal(got)
	}
	for _, c := range [][2]string{{`(?!\*)`, "a negative lookahead (?!...)"}, {`(?<=a)`, "a lookbehind (?<=...)"}, {`(?<!.)`, "a negative lookbehind (?<!...)"}, {`(?!.)`, "a negative lookahead (?!...)"}} {
		func() {
			defer func() {
				want := "NOT_COMPILED in FIND PCRE: " + c[1] + " is not in Go's RE2: " + c[0]
				if got := fmt.Sprint(recover()); got != want {
					t.Errorf("%s want %s", got, want)
				}
			}()
			FindResults("a", c[0], 'P', false, true)
		}()
	}
}

func TestPCREBareAnchorEmoji(t *testing.T) {
	for _, pair := range []string{"", `\s\S`, `\S\s`, `\d\D`, `\D\d`, `\w\W`, `\W\w`} {
		for _, start := range []bool{true, false} {
			p := "(?![" + pair + "])"
			if start {
				p = "(?<![" + pair + "])"
			}
			if pair == "" {
				p = `\z`
				if start {
					p = `\A`
				}
			}
			for _, off := range []int32{0, 1, 2, 3} {
				sec := SubS("😀a", off, NoLength)
				pos := Strlen(sec)
				if start {
					pos = 0
				}
				want := fmt.Sprintf("1[%d,0;]", pos)
				for _, all := range []bool{false, true} {
					if got := fmtRes(FindResults(sec, p, 'P', false, all)); got != want {
						t.Errorf("%s offset %d: %s want %s", p, off, got, want)
					}
				}
				wantText := "😀aX"
				if start {
					wantText = SubS("😀a", 0, off) + "X" + sec
				}
				if got, rc := ReplaceStmt("😀a", p, "X", true, true, false, off, NoLength, -1, true); got != wantText || rc != 0 {
					t.Errorf("replace %s offset %d: %q/%d want %q", p, off, got, rc, wantText)
				}
			}
		}
	}
}

func TestPCREQuantifiedLookaroundAnchors(t *testing.T) {
	for _, pair := range []string{`\s\S`, `\S\s`, `\d\D`, `\D\d`, `\w\W`, `\W\w`} {
		for _, start := range []bool{true, false} {
			anchor := "(?![" + pair + "])"
			if start {
				anchor = "(?<![" + pair + "])"
			}
			for _, q := range []string{"*", "+", "?", "{0}", "{1}"} {
				for _, s := range []string{"", "ab", "😀a"} {
					positions := []int32{0}
					var pos int32
					for _, c := range s {
						pos++
						if c > 0xffff {
							pos++
						}
						positions = append(positions, pos)
					}
					if q == "+" || q == "{1}" {
						pos = Strlen(s)
						if start {
							pos = 0
						}
						positions = []int32{pos}
					}
					want := ""
					for _, i := range positions {
						want += fmt.Sprintf("%d,0;", i)
					}
					for _, all := range []bool{false, true} {
						expected := fmt.Sprintf("%d[%s]", len(positions), want)
						if !all {
							expected = fmt.Sprintf("1[%d,0;]", positions[0])
						}
						if got := fmtRes(FindResults(s, anchor+q, 'P', false, all)); got != expected {
							t.Errorf("%s%s %q: %s want %s", anchor, q, s, got, expected)
						}
					}
					expected := s
					for i := len(positions) - 1; i >= 0; i-- {
						n := positions[i]
						expected = SubS(expected, 0, n) + "X" + SubS(expected, n, NoLength)
					}
					if got, rc := ReplaceStmt(s, anchor+q, "X", true, true, false, 0, NoLength, -1, true); got != expected || rc != 0 {
						t.Errorf("replace %s%s %q: %q/%d want %q", anchor, q, s, got, rc, expected)
					}
				}
			}
		}
	}
}

// PCRE2 10.42 error 109: written anchors are not repeatable items.
func TestPCREWrittenAnchorQuantifiers(t *testing.T) {
	for _, anchor := range []string{`\A`, `\z`, `^`, `$`} {
		for _, q := range []string{"*", "+", "?", "{0}", "{1}", "{1,}", "{1,2}"} {
			for _, gap := range []string{"", " \t", " # ignored\n"} {
				p := anchor + gap + q
				for _, replace := range []bool{false, true} {
					func() {
						defer func() {
							want := "NOT_COMPILED in FIND PCRE: quantifier does not follow a repeatable item: " + anchor
							if got := fmt.Sprint(recover()); got != want {
								t.Errorf("%q replace=%v: %s want %s", p, replace, got, want)
							}
						}()
						if replace {
							ReplaceStmt("a", p, "X", true, true, false, 0, NoLength, -1, true)
						} else {
							FindResults("a", p, 'P', false, true)
						}
					}()
				}
			}
		}
	}
	for _, p := range []string{`\\A*`, `\\z+`, `[\^$]*`, `\A.*`, `\z\x2a`, `(?-x)\A *`, "\\A # ignored *\n", `\A{,2}`, `\z{x}`} {
		extendedPCRE(p)
	}
}
