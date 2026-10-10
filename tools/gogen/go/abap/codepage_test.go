package abap

import "testing"

func TestDecodeISO88591XML(t *testing.T) {
	input := "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><a>caf\xe9 \x80</a>"
	want := "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?><a>café €</a>"
	if got := DecodeText("iso-8859-1", false, input); got != want {
		t.Fatalf("DecodeText = %q, want %q", got, want)
	}
}

func TestDecodeISO88591EveryByte(t *testing.T) {
	input := make([]byte, 256)
	want := make([]rune, 256)
	for i := range input {
		input[i], want[i] = byte(i), rune(i)
	}
	// Pin the #255 Windows-1252 mapping independently of the decoder table.
	copy(want[0x80:0xa0], []rune("€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ"))
	// C3 A4 must yield two Latin-1 code points, not one UTF-8 rune and NUL.
	input = append(input, 0xc3, 0xa4)
	want = append(want, 0xc3, 0xa4)
	for _, ignore := range []bool{false, true} {
		if got := DecodeText("iso-8859-1", ignore, string(input)); got != string(want) {
			t.Fatalf("DecodeText(ignore=%v) = %q, want %q", ignore, got, string(want))
		}
	}
}
