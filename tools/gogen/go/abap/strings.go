package abap

import (
	"math"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// String statements and built-in string functions, each rule measured on
// A4H 2026-09-23 (ZCL_GOGEN_T_STR* in testdata, EXPECT in semantics.mjs).
// Character-like arguments arrive as Go strings; a c argument has already
// lost its trailing blanks, which is what ABAP does with them everywhere
// here except the separator of SPLIT and the c field REPLACE works in.

// NoLength is the LENGTH of a SECTION that names none: the rest.
const NoLength = math.MinInt32

// PadC is a c value at its full length: the trailing blanks a c field has
// and its Go string does not. SPLIT ... AT a c separator keeps them ('a '
// splits `a b` into ” and 'b'; a c(5) holding 'x' is 'x    ').
func PadC(v string, n int) string {
	if c := int(Strlen(v)); c < n {
		return v + strings.Repeat(" ", n-c)
	}
	return v
}

// SplitInto is SPLIT v AT sep INTO t1 ... tn: more pieces than targets and
// the last target gets the rest, separators included (a,b,c, into two is a
// / b,c,); fewer and the other targets are cleared; an empty v clears them
// all; an empty separator does not split (abc into two is abc / ”).
func SplitInto(v, sep string, n int) []string {
	out := make([]string, n)
	if v == "" {
		return out
	}
	if sep == "" {
		out[0] = v
		return out
	}
	parts := strings.SplitN(v, sep, n)
	copy(out, parts)
	return out
}

// SplitSubrc is sy-subrc of SPLIT INTO fields: 4 when a piece is longer
// than the c field it goes into (it is cut there), 0 otherwise. lens holds
// the length of each c target, -1 for a string.
func SplitSubrc(pieces []string, lens []int) int32 {
	for i, p := range pieces {
		if lens[i] >= 0 && int(Strlen(p)) > lens[i] {
			return 4
		}
	}
	return 0
}

// rxAll is every match of an ABAP regex in s, in the order REPLACE ALL
// takes them (measured): leftmost-longest from the current position; after
// an empty match the next search starts one character later, after a
// non-empty one at its end, where an empty match is taken too (abbc with b*
// is -a--c-), except at the end of the string (bb with b* is -). Each match
// is the submatch index slice of Go's regexp, in bytes. first stops at one.
func rxAll(s, p string, icase, first bool) [][]int {
	re := compileABAP(p, icase)
	checkLines(p, s, "REPLACE REGEX")
	var out [][]int
	pos := 0
	for pos <= len(s) {
		var m []int
		if pos == 0 {
			m = re.FindStringSubmatchIndex(s)
		} else {
			// a match that starts at pos or later, with the character before
			// pos in view, so that ^ \b and the like see their context
			_, w := utf8.DecodeLastRuneInString(s[:pos])
			base := pos - w
			m2 := compileABAPAfter(p, icase).FindStringSubmatchIndex(s[base:])
			if m2 != nil {
				m = make([]int, len(m2)-2)
				for i := 2; i < len(m2); i++ {
					if m2[i] >= 0 {
						m[i-2] = m2[i] + base
					} else {
						m[i-2] = -1
					}
				}
			}
		}
		if m == nil {
			break
		}
		out = append(out, m)
		if first {
			break
		}
		if m[1] > m[0] {
			pos = m[1]
			if pos == len(s) {
				break
			}
			continue
		}
		if m[0] >= len(s) {
			break
		}
		_, w := utf8.DecodeRuneInString(s[m[0]:])
		pos = m[0] + w
	}
	return out
}

// compileABAPAfter is the pattern behind one arbitrary character, for a
// search that must begin after it: (?s:.)(p), leftmost-longest, so the
// first group is the match of p and the groups of p follow it.
func compileABAPAfter(p string, icase bool) *regexp.Regexp {
	compileABAP(p, icase) // the same checks and errors as the pattern itself
	key := "after\x00" + p
	if icase {
		key = "after-i\x00" + p
	}
	if r, ok := regexCache.Load(key); ok {
		return r.(*regexp.Regexp)
	}
	flags := "(?ms)"
	if icase {
		flags = "(?msi)"
	}
	re := regexp.MustCompile(flags + "(?s:.)(" + p + ")")
	re.Longest()
	regexCache.Store(key, re)
	return re
}

// plainAll is every occurrence of sub in s, left to right, not overlapping,
// as [start end] byte pairs; icase compares case-insensitively.
func plainAll(s, sub string, icase, first bool) [][]int {
	if hasHalf(s) || hasHalf(sub) {
		return plainAllWTF(s, sub, icase, first)
	}
	if icase {
		return rxAll(s, regexp.QuoteMeta(sub), true, first)
	}

	var out [][]int
	for pos := 0; pos <= len(s); {
		i := strings.Index(s[pos:], sub)
		if i < 0 {
			break
		}
		out = append(out, []int{pos + i, pos + i + len(sub)})
		if first {
			break
		}
		pos += i + len(sub)
	}
	return out
}

func plainAllWTF(s, sub string, icase, first bool) [][]int {
	s = splitSupplementary(s)
	hay, bounds := wtf16View(s)
	needle := UTF16Units(sub)
	if icase {
		// Fold scalars before splitting them; keep byte boundaries on the
		// original split subject (case mappings can change UTF-8 byte widths).
		hay = UTF16Units(ToUpper(Canon(s)))
		needle = UTF16Units(ToUpper(sub))
	}
	var out [][]int
	for pos := 0; pos+len(needle) <= len(hay); {
		i := 0
		for i < len(needle) && hay[pos+i] == needle[i] {
			i++
		}
		if i == len(needle) {
			out = append(out, []int{bounds[pos], bounds[pos+len(needle)]})
			if first {
				break
			}
			pos += len(needle)
			continue
		}
		pos++
	}
	return out
}

// rxWith is the replacement text of one regex match: $0..$9 a group (one
// that did not take part, or does not exist, is empty), $& the whole match,
// \x the character x (measured: \$1 is $1). Anything else a $ can start is
// not measured and does not compile.
func rxWith(s, with string, m []int) string {
	if !strings.ContainsAny(with, `$\`) {
		return with
	}
	group := func(g int) string {
		if 2*g+1 < len(m) && m[2*g] >= 0 {
			return s[m[2*g]:m[2*g+1]]
		}
		return ""
	}
	var b strings.Builder
	r := []rune(with)
	for i := 0; i < len(r); i++ {
		switch {
		case r[i] == '\\' && i+1 < len(r):
			i++
			b.WriteRune(r[i])
		case r[i] == '$' && i+1 < len(r) && r[i+1] >= '0' && r[i+1] <= '9':
			if i+2 < len(r) && r[i+2] >= '0' && r[i+2] <= '9' {
				panic(NotCompiled("REPLACE REGEX", "a replacement $nn of two digits is not measured: "+with))
			}
			b.WriteString(group(int(r[i+1] - '0')))
			i++
		case r[i] == '$' && i+1 < len(r) && r[i+1] == '&':
			b.WriteString(group(0))
			i++
		case r[i] == '$' || r[i] == '\\':
			panic(NotCompiled("REPLACE REGEX", "a replacement "+string(r[i:])+" is not measured"))
		default:
			b.WriteRune(r[i])
		}
	}
	return Canon(b.String())
}

// splice replaces the given matches of s (byte ranges, in order) with the
// replacement text of each.
func splice(s string, ms [][]int, with func(m []int) string) string {
	var b strings.Builder
	last := 0
	for _, m := range ms {
		b.WriteString(s[last:m[0]])
		b.WriteString(with(m))
		last = m[1]
	}
	b.WriteString(s[last:])
	return Canon(b.String())
}

// ReplaceStmt implements literal/REGEX REPLACE FIRST/ALL, optionally in a SECTION.
// off=0, ln=NoLength searches the whole subject; cLen=-1 denotes a string.
// c fields search trailing blanks, then trim/fit: subrc 2 for nonblank cuts, 0 for matches, 4 for no match.
// Empty literals insert with FIRST, raise with ALL; regex may match empty. Bad sections raise; $n needs REGEX.
func ReplaceStmt(v, p, with string, regex, all, icase bool, off, ln int32, cLen int, pcre ...bool) (string, int32) {
	return replaceStmt(v, p, with, regex, all, icase, off, ln, cLen, true, pcre...)
}

func replaceStmt(v, p, with string, regex, all, icase bool, off, ln int32, cLen int, fast bool, pcre ...bool) (string, int32) {
	if len(pcre) > 0 && pcre[0] {
		checkPCREReplacement(with)
	}
	// fast is a per-call test seam. Sections/c need bounds/padding; folding validates regex; halves match inside scalars.
	if fast && len(v) <= math.MaxInt32 && cLen < 0 && off == 0 && ln == NoLength && !regex && !icase && p != "" &&
		!hasHalf(p) && strings.Index(v, p) < 0 && !hasHalf(v) {
		return v, 4
	}
	if cLen >= 0 {
		v = PadC(v, cLen)
	}
	n := Strlen(v)
	if ln == NoLength {
		ln = n - off
	} else if ln < 0 {
		panic(NotCompiled("REPLACE", "a SECTION of negative LENGTH is not measured"))
	}
	if off < 0 || off > n || int64(off)+int64(ln) > int64(n) {
		rangeError()
	}
	sec := SubS(v, off, ln)
	var ms [][]int
	if len(pcre) > 0 && pcre[0] {
		ms = pcreAll(sec, p, icase, all)
	} else if regex {
		ms = rxAll(sec, p, icase, !all)
	} else {
		if p == "" && all {
			panic(ArithmeticError{Class: "CX_SY_REPLACE_INFINITE_LOOP", Op: "REPLACE ALL OCCURRENCES OF ''"})
		}
		if hasHalf(sec) || hasHalf(p) {
			sec = splitSupplementary(sec)
		}
		ms = plainAll(sec, p, icase, !all)
	}
	if len(ms) == 0 {
		if cLen >= 0 {
			return strings.TrimRight(v, " "), 4
		}
		return v, 4
	}
	out := JoinUTF16(SubS(v, 0, off), splice(sec, ms, func(m []int) string {
		if regex {
			return rxWith(sec, with, m)
		}
		return with
	}), SubS(v, off+ln, -1))
	if cLen >= 0 {
		if int(Strlen(out)) > cLen {
			cut := SubS(out, int32(cLen), -1)
			// Only nonblank truncation sets subrc 2.
			if strings.TrimRight(cut, " ") == "" {
				return CFit(out, cLen), 0
			}
			return CFit(out, cLen), 2
		}
		return strings.TrimRight(out, " "), 0
	}
	return out, 0
}

// ReplaceFn is replace( val sub|regex with occ ): occ 0 every occurrence,
// n > 0 the n-th, n < 0 the n-th from the end, one that does not exist
// leaves val alone; an empty sub raises CX_SY_STRG_PAR_VAL (measured).
func ReplaceFn(v, p, with string, regex bool, occ int32) string {
	if p == "" {
		if regex {
			panic(NotCompiled("replace( )", "an empty regex is not measured"))
		}
		panic(ArithmeticError{Class: "CX_SY_STRG_PAR_VAL", Op: "replace"})
	}
	var ms [][]int
	if regex {
		ms = rxAll(v, p, false, occ == 1)
	} else {
		if hasHalf(v) || hasHalf(p) {
			v = splitSupplementary(v)
		}
		ms = plainAll(v, p, false, occ == 1)
	}
	switch {
	case occ > 0 && int(occ) <= len(ms):
		ms = ms[occ-1 : occ]
	case occ < 0 && int(-occ) <= len(ms):
		ms = ms[len(ms)+int(occ) : len(ms)+int(occ)+1]
	case occ != 0:
		ms = nil
	}
	return splice(v, ms, func(m []int) string {
		if regex {
			return rxWith(v, with, m)
		}
		return with
	})
}

// Repeat is repeat( val occ ): a negative occ raises CX_SY_STRG_PAR_VAL.
func Repeat(v string, occ int32) string {
	if occ < 0 {
		panic(ArithmeticError{Class: "CX_SY_STRG_PAR_VAL", Op: "repeat"})
	}
	return Canon(strings.Repeat(v, int(occ)))
}

// CondenseFn is condense( val del from to ), measured: the characters of
// del go from both ends first, then every run of characters of from becomes
// the first character of to (none when to is empty); an empty del strips
// nothing, an empty from joins nothing.
func CondenseFn(v, del, from, to string) string {
	if hasHalf(v) || hasHalf(del) || hasHalf(from) || hasHalf(to) {
		u, d, f, t := UTF16Units(v), UTF16Units(del), UTF16Units(from), UTF16Units(to)
		contains := func(set []uint16, c uint16) bool {
			for _, x := range set {
				if x == c {
					return true
				}
			}
			return false
		}
		for len(u) > 0 && contains(d, u[0]) {
			u = u[1:]
		}
		for len(u) > 0 && contains(d, u[len(u)-1]) {
			u = u[:len(u)-1]
		}
		out := make([]uint16, 0, len(u))
		in := false
		for _, c := range u {
			if contains(f, c) {
				if !in && len(t) > 0 {
					out = append(out, t[0])
				}
				in = true
			} else {
				out = append(out, c)
				in = false
			}
		}
		return UTF16String(out)
	}
	v = strings.TrimFunc(v, func(r rune) bool { return strings.ContainsRune(del, r) })
	if from == "" {
		return v
	}
	rep := ""
	if to != "" {
		r, _ := utf8.DecodeRuneInString(to)
		rep = string(r)
	}
	var b strings.Builder
	in := false
	for _, r := range v {
		if strings.ContainsRune(from, r) {
			if !in {
				b.WriteString(rep)
			}
			in = true
			continue
		}
		in = false
		b.WriteRune(r)
	}
	return Canon(b.String())
}

// ShiftFn is shift_left / shift_right( val [places | circular | sub] ),
// measured: without an argument the blanks at that end go; places or
// circular beyond the length (or places below 0) raise
// CX_SY_RANGE_OUT_OF_BOUNDS; sub goes as often as it stands at that end.
// kind is "", "places", "circular" or "sub".
func ShiftFn(v string, left bool, kind string, n int32, sub string) string {
	l := Strlen(v)
	switch kind {
	case "":
		if left {
			return strings.TrimLeft(v, " ")
		}
		return strings.TrimRight(v, " ")
	case "places":
		if n < 0 || n > l {
			rangeError()
		}
		if left {
			return SubS(v, n, -1)
		}
		return SubS(v, 0, l-n)
	case "circular":
		if n < 0 {
			panic(NotCompiled("shift( )", "a negative circular is not measured"))
		}
		if n > l {
			rangeError()
		}
		if left {
			return JoinUTF16(SubS(v, n, -1), SubS(v, 0, n))
		}
		return JoinUTF16(SubS(v, l-n, -1), SubS(v, 0, l-n))
	}
	if sub == "" {
		panic(NotCompiled("shift( )", "an empty sub is not measured"))
	}
	for left && strings.HasPrefix(v, sub) {
		v = v[len(sub):]
	}
	for !left && strings.HasSuffix(v, sub) {
		v = v[:len(v)-len(sub)]
	}
	return v
}

// ToMixed is to_mixed( val [sep] [case] [min] ), measured: the first
// character as it is (upper with a case in upper case), every other one in
// lower case, except that a sep with at least min characters before it and
// one after it goes and the character after it is upper case (the one after
// is taken as it is, even a second sep: _a__b_ is _a_b_). hasCase says a
// case was given.
func ToMixed(v, sep string, hasCase bool, cs string, min int32) string {
	if int(Strlen(sep)) != 1 {
		panic(NotCompiled("to_mixed( )", "a sep that is not one character is not measured"))
	}
	if min < 1 {
		panic(NotCompiled("to_mixed( )", "a min below 1 is not measured"))
	}
	sepRune, _ := decode16(sep)
	var out strings.Builder
	// Fold complete Unicode scalars; only lone WTF-8 halves pass through.
	// The separator threshold still counts ABAP's UTF-16 units.
	units := int32(0)
	for i := 0; i < len(v); {
		r, width := decode16(v[i:])
		upper, fold := false, true
		switch {
		case i == 0:
			fold = hasCase
			c, _ := decode16(cs)
			upper = unicode.IsUpper(c)
		case r == sepRune && units >= min && i+width < len(v):
			i += width
			units++
			r, width = decode16(v[i:])
			upper = true
		}
		if r >= 0xd800 && r <= 0xdfff {
			out.WriteString(v[i : i+width])
		} else {
			c := r
			if fold {
				if upper {
					c = unicode.ToUpper(r)
				} else {
					c = unicode.ToLower(r)
				}
			}
			out.WriteRune(c)
		}
		units++
		if r > 0xffff {
			units++
		}
		i += width
	}
	return Canon(out.String())
}

// ConcatFit puts the result of CONCATENATE into its target (ultra/events,
// A4H ZCL_GOGEN_T_WGUI1): a string takes it whole (sy-subrc 0), a c of n
// characters takes the first n and sy-subrc is 4 when something was cut;
// n < 0 is a string. A c is held without trailing blanks.
func ConcatFit(v string, n int) (string, int32) {
	v = Canon(v)
	if n < 0 {
		return v, 0
	}
	var rc int32
	if int(Strlen(v)) > n {
		v, rc = SubS(v, 0, int32(n)), 4
	}
	return strings.TrimRight(v, " "), rc
}

// FindAllCount is FIND ALL OCCURRENCES OF [REGEX] p IN s MATCH COUNT: the
// matches, not overlapping, left to right (the order REPLACE ALL takes
// them). An empty pattern or an empty match is not measured and refused.
func FindAllCount(s, p string, regex, icase bool, pcre ...bool) int32 {
	if len(pcre) > 0 && pcre[0] {
		return int32(len(FindResults(s, p, 'P', icase, true)))
	}
	if p == "" {
		panic(NotCompiled("FIND ALL OCCURRENCES", "an empty pattern is not measured"))
	}
	var ms [][]int
	if regex {
		ms = rxAll(s, p, icase, false)
	} else {
		ms = plainAll(s, p, icase, false)
	}
	for _, m := range ms {
		if m[1] == m[0] {
			panic(NotCompiled("FIND ALL OCCURRENCES", "a regex that matches the empty string is not measured"))
		}
	}
	return int32(len(ms))
}

// EscapeHTMLAttr is escape( val = v format = cl_abap_format=>e_html_attr )
// (A4H ZCL_GOGEN_T_WGUI1): & < > " ' as entities, nothing else.
func EscapeHTMLAttr(v string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;").Replace(v)
}

// EscapeJSONString is escape( val = v format = cl_abap_format=>e_json_string )
// (A4H ZCL_GOGEN_T_JSESC): \ and " escaped, U+0008 U+0009 U+000A U+000C
// U+000D as \b \t \n \f \r, every other character below U+0020 as \u00XX
// in upper-case hex; / ' U+007F and everything beyond ASCII unchanged.
func EscapeJSONString(v string) string {
	var b strings.Builder
	write := func(r rune) {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789ABCDEF"[r>>4])
				b.WriteByte("0123456789ABCDEF"[r&15])
			} else if r >= 0xd800 && r < 0xe000 {
				b.WriteString(`\u`)
				b.WriteByte("0123456789ABCDEF"[r>>12])
				b.WriteByte("0123456789ABCDEF"[(r>>8)&15])
				b.WriteByte("0123456789ABCDEF"[(r>>4)&15])
				b.WriteByte("0123456789ABCDEF"[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	if !hasHalf(v) {
		for _, r := range v {
			write(r)
		}
		return b.String()
	}
	for i := 0; i < len(v); {
		r, width := decode16(v[i:])
		write(r)
		i += width
	}
	return b.String()
}

// SubstringBefore / SubstringAfter are substring_before / _after( val sub )
// (ultra/events, A4H ZCL_GOGEN_T_WGUI2): around the first occurrence of sub,
// empty when there is none; an empty sub is not measured and refused.
func SubstringBefore(v, sub string) string {
	if sub == "" {
		panic(NotCompiled("substring_before( )", "an empty sub is not measured"))
	}
	if i := strings.Index(v, sub); i >= 0 {
		return v[:i]
	}
	return ""
}

func SubstringAfter(v, sub string) string {
	if sub == "" {
		panic(NotCompiled("substring_after( )", "an empty sub is not measured"))
	}
	if i := strings.Index(v, sub); i >= 0 {
		return v[i+len(sub):]
	}
	return ""
}

// ConcatLinesOf is concat_lines_of( table = t sep = sep ) over a table of
// strings (ultra/httpc, cl_http_utility=>fields_to_string): the rows joined
// by sep, an empty table the empty string. The front end admits string rows
// only.
func ConcatLinesOf(t []string, sep string) string {
	return Canon(strings.Join(t, sep))
}

func checkPCREReplacement(with string) {
	for i := 0; i < len(with); i++ {
		if with[i] != '\\' {
			continue
		}
		i++
		if i >= len(with) || (with[i] != '\\' && with[i] != '$') {
			escape := "\\"
			if i < len(with) {
				escape += string(with[i])
			}
			panic(NotCompiled("REPLACE PCRE", "unsupported replacement escape "+escape))
		}
	}
}
