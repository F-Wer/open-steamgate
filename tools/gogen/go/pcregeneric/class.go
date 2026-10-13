package pcregeneric

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

type classItem struct {
	kind byte
	text string
}

// Tokenize before rebuilding: only an unescaped interior hyphen forms a range.
// Literals use scalar escapes so caret, brackets, backslash and hyphen never
// acquire positional meaning when other items are extracted or folded.
func classItems(p string, start int, refuse func(string)) ([]classItem, bool, int) {
	i := start + 1
	neg := i < len(p) && p[i] == '^'
	if neg {
		i++
	}
	var tokens []classItem
	first := true
	for i < len(p) && (p[i] != ']' || first) {
		first = false
		c := p[i]
		if c == '[' && i+1 < len(p) && strings.ContainsRune(":.=", rune(p[i+1])) {
			if p[i+1] != ':' {
				refuse("unsupported character class collating or equivalence item")
			}
			end := strings.Index(p[i+2:], ":]")
			if end < 0 {
				refuse("unterminated POSIX class")
			}
			name := p[i+2 : i+2+end]
			if !strings.Contains("|alpha|alnum|ascii|blank|cntrl|digit|graph|lower|print|punct|space|upper|word|xdigit|", "|"+name+"|") {
				refuse("an unsupported POSIX class: " + name)
			}
			tokens = append(tokens, classItem{'p', p[i : i+end+4]})
			i += end + 4
			continue
		}
		if c == '-' {
			tokens = append(tokens, classItem{'h', ""})
			i++
			continue
		}
		r, n := utf8.DecodeRuneInString(p[i:])
		i += n
		if c == '\\' {
			if i >= len(p) {
				refuse("unterminated character class escape")
			}
			escaped, size := utf8.DecodeRuneInString(p[i:])
			c = p[i]
			i += size
			if _, ok := pcreMembers[c|32]; ok {
				tokens = append(tokens, classItem{'g', string(c)})
				continue
			}
			if v, ok := map[byte]rune{'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13}[c]; ok {
				r = v
			} else if c == 'Q' || c == 'E' {
				refuse("unsupported quoting escape \\" + string(c))
			} else if c == 'A' || c == 'z' {
				refuse("unsupported anchor escape in character class \\" + string(c))
			} else if c == '8' || c == '9' {
				r = rune(c)
			} else if c >= '0' && c <= '7' {
				start := i - 1
				for i < len(p) && i-start < 3 && p[i] >= '0' && p[i] <= '7' {
					i++
				}
				v, _ := strconv.ParseUint(p[start:i], 8, 32)
				r = rune(v)
			} else if (c == 'x' || c == 'o') && i < len(p) && p[i] == '{' {
				end := strings.IndexByte(p[i:], '}')
				if end < 0 {
					refuse("unterminated character class scalar escape")
				}
				base := 16
				if c == 'o' {
					base = 8
				}
				v, err := strconv.ParseUint(p[i+1:i+end], base, 32)
				if c == 'x' && v >= 0xd800 && v <= 0xdfff {
					refuse("a surrogate hex escape (U+D800-U+DFFF)")
				}
				if c == 'x' && v > 0x10ffff {
					refuse("a hex escape above U+10FFFF")
				}
				if c == 'x' && err != nil {
					refuse("a malformed braced hex escape")
				}
				if err != nil || v > 0x10ffff || v >= 0xd800 && v <= 0xdfff {
					refuse("invalid character class scalar escape")
				}
				r = rune(v)
				i += end + 1
			} else if c == 'x' {
				start := i
				for i < len(p) && i-start < 2 && strings.ContainsRune("0123456789abcdefABCDEF", rune(p[i])) {
					i++
				}
				if i == start {
					refuse("\\x without hex digits")
				}
				v, _ := strconv.ParseUint(p[start:i], 16, 32)
				r = rune(v)
			} else {
				if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
					refuse("unsupported character class escape \\" + string(c))
				}
				r = escaped
			}
		}
		tokens = append(tokens, classItem{'l', fmt.Sprintf(`\x{%x}`, r)})
	}
	if i >= len(p) {
		refuse("unterminated character class")
	}
	var items []classItem
	for j := 0; j < len(tokens); j++ {
		t := tokens[j]
		if t.kind == 'h' {
			t = classItem{'l', `\x{2d}`}
		}
		if j+2 < len(tokens) && tokens[j+1].kind == 'h' {
			hi := tokens[j+2]
			if hi.kind == 'h' {
				hi = classItem{'l', `\x{2d}`}
			}
			if t.kind == 'g' || hi.kind == 'g' {
				refuse("a generic type as a character range endpoint")
			}
			if t.kind != 'l' || hi.kind != 'l' {
				refuse("a POSIX class as a character range endpoint")
			}
			t.text += "-" + hi.text
			j += 2
		}
		items = append(items, t)
	}
	return items, neg, i
}
