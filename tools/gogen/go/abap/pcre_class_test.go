package abap

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestPCREClassOracle(t *testing.T) {
	data, err := os.ReadFile("../../pcre-class-oracle.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle struct {
		Inputs []string
		Rows   []struct {
			Pattern   string
			Icase     bool
			Matches   []bool
			Spans     [][][]int32
			Supported bool
		}
	}
	if err := json.Unmarshal(data, &oracle); err != nil {
		t.Fatal(err)
	}
	for _, row := range oracle.Rows {
		t.Run(fmt.Sprintf("%s/icase=%t", row.Pattern, row.Icase), func(t *testing.T) {
			if !row.Supported {
				defer func() {
					if recover() == nil {
						t.Error("reference accepted")
					}
				}()
				FindResults("aa", row.Pattern, 'P', row.Icase, true)
				return
			}
			if row.Matches == nil {
				defer func() {
					if e := fmt.Sprint(recover()); !strings.Contains(e, "generic type as a character range endpoint") {
						t.Errorf("refusal: %s", e)
					}
				}()
				FindResults("-", row.Pattern, 'P', row.Icase, true)
				return
			}
			for i, s := range oracle.Inputs {
				got := FindResults(s, row.Pattern, 'P', row.Icase, true)
				if len(got) != len(row.Spans[i]) || len(got) > 0 && !reflect.DeepEqual(got, row.Spans[i]) {
					t.Errorf("%q: %v want %v", s, got, row.Spans[i])
				}
				result, rc := ReplaceStmt(s, row.Pattern, "X", true, true, row.Icase, 0, NoLength, -1, true)
				want, wantRC := s, int32(4)
				if row.Matches[i] {
					wantRC = 0
					for j := len(row.Spans[i]) - 1; j >= 0; j-- {
						r := row.Spans[i][j]
						want = SubS(want, 0, r[0]) + "X" + SubS(want, r[0]+r[1], NoLength)
					}
				}
				if result != want || rc != wantRC {
					t.Errorf("replace %q: %q/%d want %q/%d", s, result, rc, want, wantRC)
				}
			}
		})
	}
}

func TestPCREClassUnmodeledItems(t *testing.T) {
	for _, c := range [][2]string{
		{`[\B]`, `unsupported character class escape \B`},
		{`[\p{L}\s]`, `unsupported character class escape \p`},
		{`[[.a.]\s]`, `collating or equivalence item`},
		{`[[:space:]-a]`, `POSIX class as a character range endpoint`},
	} {
		func() {
			defer func() {
				if e := fmt.Sprint(recover()); !strings.Contains(e, c[1]) {
					t.Errorf("%s: %s", c[0], e)
				}
			}()
			FindResults("a", c[0], 'P', false, true)
		}()
	}
	if got := fmtRes(FindResults("ab", `[\s^a]`, 'P', false, true)); got != "1[0,1;]" {
		t.Fatal(got)
	}
}
