package charsearch

import (
	"osg/gogen/abap"
	"testing"
)

func TestOriginalPositionAfterUppercaseExpansion(t *testing.T) {
	s := &abap.Session{}
	if WithPos(s, "aß", "x") || s.Sy.Fdpos != 2 {
		t.Fatalf("miss position = %d, want 2", s.Sy.Fdpos)
	}
	if !WithPos(s, "ßa", "a") || s.Sy.Fdpos != 1 {
		t.Fatalf("expanded prefix offset = %d", s.Sy.Fdpos)
	}
	if !WithPos(s, "aß", "ss") || s.Sy.Fdpos != 1 {
		t.Fatalf("expansion match offset = %d", s.Sy.Fdpos)
	}
}

func TestCharacterSetPositions(t *testing.T) {
	cases := []struct {
		a, b string
		co   bool
		cop  int32
		ca   bool
		cap  int32
	}{
		{"", "", true, 0, false, 0},
		{"", "a", true, 0, false, 0},
		{"abc", "", false, 0, false, 3},
		{"abba", "ab", true, 4, true, 0},
		{"abX", "ab", false, 2, true, 0},
		{"XXb", "ab", false, 0, true, 2},
		{"ABC", "abc", false, 0, false, 3},
		{"ab ", "ab", false, 2, true, 0},
		{"ab ", "ab ", true, 3, true, 0},
		{"😀x", "x", false, 0, true, 2},
		{"😀x", "😀", false, 2, true, 0},
	}
	for _, c := range cases {
		s := &abap.Session{}
		s.Sy.Fdpos = 999
		if got := OnlyWithPos(s, c.a, c.b); got != c.co || s.Sy.Fdpos != c.cop {
			t.Errorf("%q CO %q = %v/%d, want %v/%d", c.a, c.b, got, s.Sy.Fdpos, c.co, c.cop)
		}
		s.Sy.Fdpos = 999
		if got := AnyWithPos(s, c.a, c.b); got != c.ca || s.Sy.Fdpos != c.cap {
			t.Errorf("%q CA %q = %v/%d, want %v/%d", c.a, c.b, got, s.Sy.Fdpos, c.ca, c.cap)
		}
	}
	half := abap.UTF16String([]uint16{0xD83D})
	s := &abap.Session{}
	if !AnyWithPos(s, "😀", half) || s.Sy.Fdpos != 0 {
		t.Fatal("surrogate half membership lost")
	}
	if OnlyWithPos(s, "😀", half) || s.Sy.Fdpos != 1 {
		t.Fatal("second UTF-16 unit not tested")
	}
}
