package pcreanchor

import "strings"

// AbsoluteAnchor recognizes only the exact complementary-class assertions.
// Call at a syntax position, after skipping names, escapes, classes and comments.
func AbsoluteAnchor(p string, i int) (string, int) {
	for _, prefix := range []string{"(?<!", "(?!"} {
		for _, class := range []string{`[\s\S]`, `[\S\s]`, `[\d\D]`, `[\D\d]`, `[\w\W]`, `[\W\w]`} {
			token := prefix + class + ")"
			if strings.HasPrefix(p[i:], token) {
				if prefix == "(?<!" {
					return `\A`, len(token)
				}
				return `\z`, len(token)
			}
		}
	}
	return "", 0
}

// QuantifierAt recognizes repetition at a syntax position; literal braces are excluded.
func QuantifierAt(p string, i int) bool {
	if strings.ContainsRune("*+?", rune(p[i])) {
		return true
	}
	if p[i] != '{' {
		return false
	}
	j := i + 1
	for j < len(p) && p[j] >= '0' && p[j] <= '9' {
		j++
	}
	if j == i+1 {
		return false
	}
	if j < len(p) && p[j] == ',' {
		j++
		for j < len(p) && p[j] >= '0' && p[j] <= '9' {
			j++
		}
	}
	return j < len(p) && p[j] == '}'
}
