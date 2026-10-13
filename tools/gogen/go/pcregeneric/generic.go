package pcregeneric

import (
	"fmt"
	"regexp/syntax"
	"sort"
	"strings"
	"unicode"
)

// PCRE2 non-UCP generic types; SAP's UCP setting unmeasured; measure on A4H.
// RE2's boundaries and digit/word types are ASCII, even with i. Explicit
// word classes need i disabled, since ordinary ranges otherwise fold ſ/K.
var pcreMembers = map[byte]string{'s': `\t\n\x{b}\f\r `, 'd': `0-9`, 'w': `A-Za-z0-9_`}

func genericRanges(members string, icase bool, refuse func(string)) []rune {
	flags := syntax.Perl
	if icase {
		flags |= syntax.FoldCase
	}
	r, err := syntax.Parse("["+members+"]", flags)
	if err != nil {
		refuse("a generic type class or range: " + members)
	}
	switch r.Op {
	case syntax.OpCharClass:
		return r.Rune
	case syntax.OpLiteral:
		lo := r.Rune[0]
		rs := []rune{lo, lo}
		if r.Flags&syntax.FoldCase != 0 {
			for next := unicode.SimpleFold(lo); next != lo; next = unicode.SimpleFold(next) {
				rs = append(rs, next, next)
			}
		}
		return rs
	case syntax.OpAnyChar:
		return []rune{0, 0x10ffff}
	case syntax.OpAnyCharNotNL:
		return []rune{0, 9, 11, 0x10ffff}
	}
	refuse("a generic type class: " + members)
	return nil
}

func mergeGeneric(rs []rune) []rune {
	pairs := make([][2]rune, len(rs)/2)
	for i := range pairs {
		pairs[i] = [2]rune{rs[2*i], rs[2*i+1]}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i][0] < pairs[j][0] })
	var out []rune
	for _, p := range pairs {
		if len(out) > 0 && p[0] <= out[len(out)-1]+1 {
			if p[1] > out[len(out)-1] {
				out[len(out)-1] = p[1]
			}
		} else {
			out = append(out, p[:]...)
		}
	}
	return out
}

func complementGeneric(rs []rune) []rune {
	var out []rune
	next := rune(0)
	for i := 0; i < len(rs); i += 2 {
		if next < rs[i] {
			out = append(out, next, rs[i]-1)
		}
		next = rs[i+1] + 1
	}
	if next <= 0x10ffff {
		out = append(out, next, 0x10ffff)
	}
	return out
}

func emitGeneric(rs []rune) string {
	if len(rs) == 0 {
		return `[^\x{0}-\x{10ffff}]`
	}
	var out strings.Builder
	out.WriteString("(?-i:[")
	for i := 0; i < len(rs); i += 2 {
		fmt.Fprintf(&out, `\x{%x}-\x{%x}`, rs[i], rs[i+1])
	}
	out.WriteString("])")
	return out.String()
}

func Normalize(p string, icase bool, refuse func(string)) string {
	var out strings.Builder
	for i := 0; i < len(p); i++ {
		if name := Name(p, i); name != "" {
			out.WriteString(Capture(name))
			i += len(name) - 1
			continue
		}
		if p[i] == '\\' && i+1 < len(p) {
			c := p[i+1]
			lower := c | 32
			if members, ok := pcreMembers[lower]; ok {
				rs := genericRanges(members, false, refuse)
				if c != lower {
					rs = complementGeneric(rs)
				}
				out.WriteString(emitGeneric(rs))
			} else {
				out.WriteString(p[i : i+2])
			}
			i++
			continue
		}
		if p[i] != '[' {
			out.WriteByte(p[i])
			continue
		}
		items, neg, end := classItems(p, i, refuse)
		i = end
		var rs []rune
		for _, item := range items {
			if item.kind == 'g' {
				c := item.text[0]
				r := genericRanges(pcreMembers[c|32], false, refuse)
				if c != c|32 {
					r = complementGeneric(r)
				}
				rs = append(rs, r...)
			} else {
				r := genericRanges(item.text, icase, refuse)
				if item.kind == 'p' {
					var ascii []rune
					for k := 0; k < len(r); k += 2 {
						if r[k] <= 127 {
							ascii = append(ascii, r[k], min(r[k+1], 127))
						}
					}
					r = ascii
				}
				rs = append(rs, r...)
			}
		}
		rs = mergeGeneric(rs)
		if neg {
			rs = complementGeneric(rs)
		}
		out.WriteString(emitGeneric(rs))
	}
	return out.String()
}
