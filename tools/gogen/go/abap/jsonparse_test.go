package abap

import "testing"

// the answers of Node's JSON.parse (and of the walk of open-abap-core's
// LCL_JSON_PARSER=>TRAVERSE) for the same texts, recorded with node 22
func TestJSNumberString(t *testing.T) {
	for _, c := range [][2]string{
		{"0", "0"},
		{"-0", "0"},
		{"1", "1"},
		{"1.0", "1"},
		{"1.5", "1.5"},
		{"-2.25", "-2.25"},
		{"1e21", "1e+21"},
		{"1e20", "100000000000000000000"},
		{"123456789012345678901", "123456789012345680000"},
		{"0.000001", "0.000001"},
		{"0.0000001", "1e-7"},
		{"1e-7", "1e-7"},
		{"1.5e-10", "1.5e-10"},
		{"5e-324", "5e-324"},
		{"1.7976931348623157e308", "1.7976931348623157e+308"},
		{"1e999", "Infinity"},
		{"-1e999", "-Infinity"},
		{"0.1", "0.1"},
		{"0.30000000000000004", "0.30000000000000004"},
		{"100", "100"},
		{"1E3", "1000"},
		{"2.5e+2", "250"},
		{"12345678.9", "12345678.9"},
		{"9007199254740993", "9007199254740992"},
		{"4.35", "4.35"},
		{"1e-6", "0.000001"},
		{"123e-20", "1.23e-18"},
	} {
		nodes, ok := JSONNodes(c[0])
		if !ok || len(nodes) != 3 || nodes[1].Value != c[1] {
			t.Errorf("%s: got %v, want %s", c[0], nodes, c[1])
		}
	}
}

func TestJSONNodes(t *testing.T) {
	for _, c := range []struct {
		text  string
		nodes []JSONNode
	}{
		{"{\"b\":1,\"a\":2,\"1\":3,\"0\":4,\"10\":5,\"01\":6,\"b\":7}", []JSONNode{{1, "object", "", "", false}, {1, "num", "0", "", true}, {4, "", "", "4", false}, {2, "num", "", "", false}, {1, "num", "1", "", true}, {4, "", "", "3", false}, {2, "num", "", "", false}, {1, "num", "10", "", true}, {4, "", "", "5", false}, {2, "num", "", "", false}, {1, "num", "b", "", true}, {4, "", "", "7", false}, {2, "num", "", "", false}, {1, "num", "a", "", true}, {4, "", "", "2", false}, {2, "num", "", "", false}, {1, "num", "01", "", true}, {4, "", "", "6", false}, {2, "num", "", "", false}, {2, "object", "", "", false}}},
		{"[1,[2,{}],[]]", []JSONNode{{1, "array", "", "", false}, {1, "num", "", "", false}, {4, "", "", "1", false}, {2, "num", "", "", false}, {1, "array", "", "", false}, {1, "num", "", "", false}, {4, "", "", "2", false}, {2, "num", "", "", false}, {1, "object", "", "", false}, {2, "object", "", "", false}, {2, "array", "", "", false}, {1, "array", "", "", false}, {2, "array", "", "", false}, {2, "array", "", "", false}}},
		{"{\"x\":\"a\\u00e9\\ud83d\\ude00\\n\",\"y\":null,\"z\":true,\"w\":false}", []JSONNode{{1, "object", "", "", false}, {1, "str", "x", "", true}, {4, "", "", "aé😀\n", false}, {2, "str", "", "", false}, {1, "null", "y", "", true}, {2, "null", "", "", false}, {1, "bool", "z", "", true}, {4, "", "", "true", false}, {2, "bool", "", "", false}, {1, "bool", "w", "", true}, {4, "", "", "false", false}, {2, "bool", "", "", false}, {2, "object", "", "", false}}},
		{" {\"4294967294\":1,\"4294967295\":2,\"-1\":3} ", []JSONNode{{1, "object", "", "", false}, {1, "num", "4294967294", "", true}, {4, "", "", "1", false}, {2, "num", "", "", false}, {1, "num", "4294967295", "", true}, {4, "", "", "2", false}, {2, "num", "", "", false}, {1, "num", "-1", "", true}, {4, "", "", "3", false}, {2, "num", "", "", false}, {2, "object", "", "", false}}},
		{"\"top\"", []JSONNode{{1, "str", "", "", false}, {4, "", "", "top", false}, {2, "str", "", "", false}}},
	} {
		got, ok := JSONNodes(c.text)
		if !ok || len(got) != len(c.nodes) {
			t.Errorf("%s: got %v", c.text, got)
			continue
		}
		for i := range got {
			if got[i] != c.nodes[i] {
				t.Errorf("%s: node %d is %v, want %v", c.text, i, got[i], c.nodes[i])
			}
		}
	}
	for _, c := range []struct {
		text string
		ok   bool
	}{
		{"{\"a\":1,}", false},
		{"[1,]", false},
		{"01", false},
		{"{a:1}", false},
		{"'x'", false},
		{"\"\\x\"", false},
		{"[1] 2", false},
		{"", false},
		{" ", false},
		{"{\"a\" 1}", false},
		{"-", false},
		{"1.", false},
		{".5", false},
		{"\"a\tb\"", false},
		{"tru", false},
		{"NaN", false},
		{"[1,2", false},
		{"\ufeff1", false},
	} {
		if _, ok := JSONNodes(c.text); ok != c.ok {
			t.Errorf("%q: ok %v, want %v", c.text, ok, c.ok)
		}
	}
}

// Presence is distinct from an empty key; only object-member opens have it.
func TestJSONNodeKeyPresence(t *testing.T) {
	nodes, ok := JSONNodes(`{"":1,"a":[{},2],"z":null}`)
	if !ok {
		t.Fatal("parse failed")
	}
	var keys []string
	for _, n := range nodes {
		if n.HasKey {
			if n.Type != 1 {
				t.Fatalf("non-open has key: %+v", n)
			}
			keys = append(keys, n.Key)
		}
	}
	if len(keys) != 3 || keys[0] != "" || keys[1] != "a" || keys[2] != "z" {
		t.Fatalf("member keys: %q", keys)
	}
}

// Fill both current and older core layouts; ABAP_BOOL must be X or blank.
func TestFillJSONNodesKeyPresence(t *testing.T) {
	type row struct {
		Type                     int32
		Name, Key, Value, HasKey string
	}
	nodes, ok := JSONNodes(`{"":{},"a":[{"":null},2]}`)
	if !ok {
		t.Fatal("parse failed")
	}
	for _, withKey := range []bool{false, true} {
		rt := &Type{Kind: 'u', Comps: []Comp{
			{Name: "TYPE", T: TI, Get: func(p any) any { return &p.(*row).Type }},
			{Name: "NAME", T: TString, Get: func(p any) any { return &p.(*row).Name }},
			{Name: "KEY", T: TString, Get: func(p any) any { return &p.(*row).Key }},
			{Name: "VALUE", T: TString, Get: func(p any) any { return &p.(*row).Value }},
		}}
		if withKey {
			rt.Comps = append(rt.Comps, Comp{Name: "HAS_KEY", T: TC(1), Get: func(p any) any { return &p.(*row).HasKey }})
		}
		rows := []row{{Name: "stale"}}
		tt := &Type{Kind: 'h', Row: rt, Zero: func(p any) { *p.(*[]row) = nil }, Append: func(p any) any {
			rows := p.(*[]row)
			*rows = append(*rows, row{})
			return &(*rows)[len(*rows)-1]
		}}
		FillJSONNodes(Data{P: &rows, T: tt}, nodes)
		if len(rows) != len(nodes) {
			t.Fatalf("got %d rows, want %d", len(rows), len(nodes))
		}
		for i, r := range rows {
			n := nodes[i]
			if r.Type != n.Type || r.Name != n.Name || r.Key != n.Key || r.Value != n.Value {
				t.Fatalf("row %d: %+v", i, r)
			}
			if withKey {
				want := "" // Fixed CHAR stores its blank value without trailing spaces.
				if n.HasKey {
					want = "X"
				}
				c, _ := Component(Data{P: &rows[i], T: rt}, "HAS_KEY")
				if got := DataString(c); got != want {
					t.Fatalf("row %d HAS_KEY %q, want %q", i, got, want)
				}
			}
		}
	}
}
