package abap

import (
	"strings"
	"sync/atomic"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

// Go strings are immutable. Retaining the source keeps its backing memory
// alive, so pointer+length identity cannot hit a reused address. Each entry
// is immutable and atomically published; concurrent misses or eviction only
// affect hit rate, never the conversion returned. Keep at most four sources;
// short conversions do bounded work and must not evict cached documents.
type encodedMemo struct {
	source  string
	encoded string
}

var utf16Memos [4]atomic.Pointer[encodedMemo]

// EncodeText is cl_abap_conv_out_ce->convert: the characters of a string as
// the bytes of an encoding. open-abap's create( ) sets the encoding to
// "utf8" (UTF-8 or none) or "utf16le" (code page 4103); any other name is
// refused there already.
func EncodeText(encoding, text string) string {
	switch encoding {
	case "utf8":
		return text
	case "utf16le", "utf-16le":
		if len(text) >= 256 {
			for i := range utf16Memos {
				if m := utf16Memos[i].Load(); m != nil && len(m.source) == len(text) && unsafe.StringData(m.source) == unsafe.StringData(text) {
					return m.encoded
				}
			}
		}
		u := UTF16Units(text)
		b := make([]byte, 0, 2*len(u))
		for _, c := range u {
			b = append(b, byte(c), byte(c>>8))
		}
		encoded := string(b)
		if len(text) < 256 {
			return encoded
		}
		slot, shortest := 0, int(^uint(0)>>1)
		for i := range utf16Memos {
			old := utf16Memos[i].Load()
			if old == nil {
				slot = i
				break
			}
			if len(old.source) < shortest {
				slot, shortest = i, len(old.source)
			}
		}
		utf16Memos[slot].Store(&encodedMemo{source: text, encoded: encoded})
		return encoded
	}
	panic(NotCompiled("CL_ABAP_CONV_OUT_CE=>CONVERT", "encoding "+encoding))
}

// DecodeText is cl_abap_conv_in_ce->convert: bytes read as text. A byte
// sequence that is not valid UTF-8 raises CX_SY_CONVERSION_CODEPAGE unless
// IGNORE_CERR was set; then TextDecoder substitutes replacement characters.
func DecodeText(encoding string, ignoreErrors bool, data string) string {
	switch encoding {
	case "utf8":
		if !utf8.ValidString(data) {
			if ignoreErrors {
				return strings.ToValidUTF8(data, "\ufffd")
			}
			panic(ArithmeticError{Class: "CX_SY_CONVERSION_CODEPAGE", Op: "CL_ABAP_CONV_IN_CE=>CONVERT"})
		}
		return data
	case "iso-8859-1":
		// ISO-8859-1 maps each byte to the same Unicode code point,
		// including C1 controls. A string range would skip UTF-8 continuations.
		runes := make([]rune, len(data))
		for i := 0; i < len(data); i++ {
			runes[i] = rune(data[i])
		}
		return string(runes)
	case "utf16le", "utf-16le":
		if len(data)%2 != 0 {
			panic(NotCompiled("CL_ABAP_CONV_IN_CE=>CONVERT", "an odd number of UTF-16 bytes"))
		}
		u := make([]uint16, len(data)/2)
		for i := range u {
			u[i] = uint16(data[2*i]) | uint16(data[2*i+1])<<8
		}
		for i := 0; i < len(u); i++ {
			if utf16.IsSurrogate(rune(u[i])) {
				if i+1 < len(u) && u[i] >= 0xD800 && u[i] < 0xDC00 && u[i+1] >= 0xDC00 && u[i+1] < 0xE000 {
					i++
					continue
				}
				panic(NotCompiled("CL_ABAP_CONV_IN_CE=>CONVERT", "an unpaired UTF-16 surrogate"))
			}
		}
		return string(utf16.Decode(u))
	}
	panic(NotCompiled("CL_ABAP_CONV_IN_CE=>CONVERT", "encoding "+encoding))
}
