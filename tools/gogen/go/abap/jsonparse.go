package abap

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// The kernel half of open-abap-core's JSON reader (CL_SXML_STRING_READER,
// LCL_JSON_PARSER=>PARSE and its TRAVERSE methods), whose work on Node is
// JavaScript: JSON.parse, then a walk over the value that lists nodes. The
// same list here, with JSON.parse's rules (ECMA-262 JSON.parse, ECMA-404):
//
//   - the grammar is strict JSON: no comments, no trailing commas, no
//     leading zeros, whitespace only space, tab, LF and CR;
//   - an object's keys come in JavaScript's own-property order: keys that
//     are array indexes (the canonical decimal of an integer below 2^32-1)
//     first, ascending, then the others in the order they first appeared;
//     a repeated key keeps its first place and takes its last value;
//   - a number becomes its JavaScript text (Number.prototype.toString:
//     1.0 is "1", 1e21 is "1e+21", 1e999 is "Infinity");
//   - strings preserve lone UTF-16 surrogates as WTF-8; escaped pairs
//     become their canonical supplementary character.
//
// A text that is not JSON answers ok false; the reader raises
// CX_SXML_PARSE_ERROR then. On Node its XML_OFFSET is the position V8 names
// in its message, when the message has one (Node 20 and later mostly do
// not); here it is 0.

// JSONNode is one entry of LCL_JSON_PARSER=>TY_NODES: a node type of
// IF_SXML_NODE (1 open, 2 close, 4 value), the element name (object,
// array, str, num, bool, null), the member's key and the value's text.
type JSONNode struct {
	Type   int32
	Name   string
	Key    string
	Value  string
	HasKey bool
}

type jsonValue struct {
	kind  byte // o a s n b z(null)
	text  string
	keys  []string
	vals  map[string]*jsonValue
	items []*jsonValue
}

type jsonParser struct {
	s   string
	i   int
	bad bool
}

func (p *jsonParser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jsonParser) fail() *jsonValue { p.bad = true; return nil }

func (p *jsonParser) value() *jsonValue {
	p.ws()
	if p.i >= len(p.s) {
		return p.fail()
	}
	switch c := p.s[p.i]; {
	case c == '{':
		p.i++
		v := &jsonValue{kind: 'o', vals: map[string]*jsonValue{}}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return v
		}
		for {
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return p.fail()
			}
			k, ok := p.str()
			if !ok {
				return p.fail()
			}
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return p.fail()
			}
			p.i++
			x := p.value()
			if p.bad {
				return nil
			}
			if _, seen := v.vals[k]; !seen {
				v.keys = append(v.keys, k)
			}
			v.vals[k] = x
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.s) && p.s[p.i] == '}' {
				p.i++
				return v
			}
			return p.fail()
		}
	case c == '[':
		p.i++
		v := &jsonValue{kind: 'a'}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return v
		}
		for {
			x := p.value()
			if p.bad {
				return nil
			}
			v.items = append(v.items, x)
			p.ws()
			if p.i < len(p.s) && p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.s) && p.s[p.i] == ']' {
				p.i++
				return v
			}
			return p.fail()
		}
	case c == '"':
		t, ok := p.str()
		if !ok {
			return p.fail()
		}
		return &jsonValue{kind: 's', text: t}
	case c == '-' || (c >= '0' && c <= '9'):
		return p.num()
	case strings.HasPrefix(p.s[p.i:], "true"):
		p.i += 4
		return &jsonValue{kind: 'b', text: "true"}
	case strings.HasPrefix(p.s[p.i:], "false"):
		p.i += 5
		return &jsonValue{kind: 'b', text: "false"}
	case strings.HasPrefix(p.s[p.i:], "null"):
		p.i += 4
		return &jsonValue{kind: 'z'}
	}
	return p.fail()
}

func (p *jsonParser) num() *jsonValue {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return p.fail()
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return p.fail()
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return p.fail()
		}
	}
	// ParseFloat rounds to nearest as JavaScript does; out of range it
	// answers ±Inf with an error, which is JavaScript's Infinity
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !math.IsInf(f, 0) {
		return p.fail()
	}
	return &jsonValue{kind: 'n', text: JSNumberString(f)}
}

// str reads a string literal at p.i (the opening quote) and decodes it.
func (p *jsonParser) str() (string, bool) {
	p.i++
	var units []uint16
	var b strings.Builder
	flush := func() bool {
		if len(units) == 0 {
			return true
		}
		b.WriteString(UTF16String(units))
		units = units[:0]
		return true
	}
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			flush()
			p.i++
			return Canon(b.String()), true
		case c < 0x20:
			return "", false
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return "", false
			}
			e := p.s[p.i+1]
			p.i += 2
			if e == 'u' {
				if p.i+4 > len(p.s) {
					return "", false
				}
				n, err := strconv.ParseUint(p.s[p.i:p.i+4], 16, 16)
				if err != nil || strings.ContainsAny(p.s[p.i:p.i+4], "+-") {
					return "", false
				}
				units = append(units, uint16(n))
				p.i += 4
				continue
			}
			flush()
			r, ok := map[byte]byte{'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}[e]
			if !ok {
				return "", false
			}
			b.WriteByte(r)
		default:
			flush()
			r, size := decode16(p.s[p.i:])
			if r >= 0xd800 && r < 0xe000 {
				b.WriteString(p.s[p.i : p.i+size])
			} else {
				b.WriteRune(r)
			}
			p.i += size
		}
	}
	return "", false
}

// arrayIndex: a key JavaScript orders first, as an integer (ECMA-262
// array index: the canonical decimal of an integer 0 .. 2^32-2)
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 1<<32-1 {
		return 0, false
	}
	return n, true
}

func (v *jsonValue) orderedKeys() []string {
	var idx, rest []string
	for _, k := range v.keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(i, j int) bool { a, _ := arrayIndex(idx[i]); b, _ := arrayIndex(idx[j]); return a < b })
	return append(idx, rest...)
}

// JSNumberString is JavaScript's Number.prototype.toString( ) of f.
func JSNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// the shortest digits that read back as f (both Go and ECMA-262 pick the
	// nearest of the shortest), and n: the decimal point after n digits
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k, n := len(digits), x+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	es := "+"
	if n-1 < 0 {
		es = "-"
	}
	ev := strconv.Itoa(abs(n - 1))
	if k == 1 {
		return sign + digits + "e" + es + ev
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + ev
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// JSONNodes is JSON.parse of text and the walk of LCL_JSON_PARSER=>TRAVERSE
// over the value: the nodes in order, or ok false for a text that is not JSON.
func JSONNodes(text string) (nodes []JSONNode, ok bool) {
	p := &jsonParser{s: text}
	v := p.value()
	p.ws()
	if p.bad || p.i != len(p.s) {
		return nil, false
	}
	var walk func(v *jsonValue, key string, hasKey bool)
	walk = func(v *jsonValue, key string, hasKey bool) {
		name := map[byte]string{'o': "object", 'a': "array", 's': "str", 'n': "num", 'b': "bool", 'z': "null"}[v.kind]
		nodes = append(nodes, JSONNode{Type: 1, Name: name, Key: key, HasKey: hasKey})
		switch v.kind {
		case 'o':
			for _, k := range v.orderedKeys() {
				walk(v.vals[k], k, true)
			}
		case 'a':
			for _, x := range v.items {
				walk(x, "", false)
			}
		case 's', 'n', 'b':
			nodes = append(nodes, JSONNode{Type: 4, Value: v.text})
		}
		nodes = append(nodes, JSONNode{Type: 2, Name: name})
	}
	walk(v, "", false)
	return nodes, true
}

// FillJSONNodes replaces LCL_JSON_PARSER's node table, including optional HAS_KEY.
func FillJSONNodes(ref Data, nodes []JSONNode) {
	if ref.P == nil {
		panic(notAssigned("LCL_JSON_PARSER=>PARSE: IT_NODES"))
	}
	ClearData(ref)
	for _, n := range nodes {
		if ref.T.Append == nil {
			panic(NotCompiled("LCL_JSON_PARSER=>PARSE", "IT_NODES is not a standard table"))
		}
		row := Data{P: ref.T.Append(ref.P), T: ref.T.Row}
		if c, ok := Component(row, "HAS_KEY"); ok { // Older core pins omit it.
			hasKey := " "
			if n.HasKey {
				hasKey = "X"
			}
			MoveData(c, Data{P: &hasKey, T: TString})
		}
		typ := n.Type
		for _, f := range []struct {
			name string
			v    Data
		}{{"TYPE", Data{P: &typ, T: TI}}, {"NAME", Data{P: &n.Name, T: TString}}, {"KEY", Data{P: &n.Key, T: TString}}, {"VALUE", Data{P: &n.Value, T: TString}}} {
			c, ok := Component(row, f.name)
			if !ok {
				panic(NotCompiled("LCL_JSON_PARSER=>PARSE", "IT_NODES has no component "+f.name))
			}
			MoveData(c, f.v)
		}
	}
}
