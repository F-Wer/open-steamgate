package abap

import "testing"

func TestComponentIndexBinding(t *testing.T) {
	row := struct{ First, Second string }{"\x01\x02", "Q"}
	typ := &Type{Kind: 'u', Comps: []Comp{
		{Name: "FIRST", T: TX(2), Get: func(p any) any { return &p.(*struct{ First, Second string }).First }},
		{Name: "SECOND", T: TC(1), Get: func(p any) any { return &p.(*struct{ First, Second string }).Second }},
	}}
	valid := true
	d := Data{P: &row, T: typ, Valid: func() bool { return valid }}
	first, ok := Component(d, int32(1))
	if !ok || first.T != TX(2) || DataString(first) != "0102" {
		t.Fatalf("first: %#v, %v", first, ok)
	}
	bytes := "\xCC\xDD"
	MoveData(first, Data{P: &bytes, T: TX(2)})
	if row.First != bytes {
		t.Fatal("component write did not reach row")
	}
	second, ok := Component(d, int32(2))
	if !ok || DataString(second) != "Q" {
		t.Fatal("second component")
	}
	for _, index := range []int32{-1, 0, 3} {
		c, ok := Component(d, index)
		if ok || c.P != nil {
			t.Fatalf("index %d: %#v, %v", index, c, ok)
		}
	}
	for _, value := range []Data{{}, {P: &bytes, T: TX(2)}} {
		c, ok := Component(value, int32(1))
		if ok || c.P != nil {
			t.Fatal("non-structure bound a component")
		}
	}
	valid = false
	defer func() {
		if recover() == nil {
			t.Fatal("component lost row validity")
		}
	}()
	first.Check()
}
