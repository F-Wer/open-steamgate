package pcregeneric

import (
	"regexp"
	"strings"
)

// Named syntax is opaque to every atom walker. Reference prefixes remain
// visible to refusal checks, while their names never become regex atoms.
var named = regexp.MustCompile(`^(?:\(\?<[^=!][^>]*>|\(\?P<[^>]+>|\(\?'[^']+'|\\[kg](?:<[^>]+>|\{[^}]+\}|'[^']+'))`)

func Name(p string, i int) string { return named.FindString(p[i:]) }
func Capture(name string) string {
	if strings.HasPrefix(name, "(?'") {
		return "(?P<" + name[3:len(name)-1] + ">"
	}
	return name
}
func Class(p string, start int, refuse func(string)) (string, int) {
	items, neg, end := classItems(p, start, refuse)
	out := "["
	if neg {
		out += "^"
	}
	for _, t := range items {
		if t.kind == 'g' {
			out += `\`
		}
		out += t.text
	}
	return out + "]", end
}
func Syntax(p string, escapes bool, refuse func(string)) string {
	var out strings.Builder
	for i := 0; i < len(p); i++ {
		if name := Name(p, i); name != "" {
			if name[0] == '\\' {
				out.WriteString(name[:3])
			} else {
				out.WriteByte('_')
			}
			i += len(name) - 1
		} else if p[i] == '[' {
			_, end := Class(p, i, refuse)
			i = end
			out.WriteByte('_')
		} else if p[i] == '\\' && i+1 < len(p) {
			if p[i+1] == 'x' && i+2 < len(p) && p[i+2] == '{' {
				end := strings.IndexByte(p[i+3:], '}')
				i += end + 3
				out.WriteByte('_')
			} else {
				if escapes && p[i+1] != '\\' {
					out.WriteString(p[i : i+2])
				} else {
					out.WriteByte('_')
				}
				i++
			}
		} else {
			out.WriteByte(p[i])
		}
	}
	return out.String()
}
