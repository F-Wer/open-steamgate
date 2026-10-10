package abap

import (
	"reflect"
	"strings"
	"sync"
)

// Generic data: TYPE any, TYPE data, ANY TABLE and REF TO data.
//
// Typed code keeps its own Go types. A generic value is a Data: a pointer to
// the storage slot it stands for (the variable, the field, the row) and the
// descriptor of that slot's ABAP type. It is a binding, never a copy, so a
// write through a field symbol or a data reference reaches the original, and
// GET REFERENCE OF a local keeps the local alive (Go moves it to the heap).
//
// The descriptors of structures and tables are generated with the program:
// a component knows how to reach its field inside a struct, a table how many
// rows it has and where row i lives. Elementary ones are here.
type Type struct {
	Kind	byte	// cl_abap_typedescr=>typekind_*: I 8 F g y C X D T u h l
	Len	int
	Comps	[]Comp
	Row	*Type
	Lines	func(p any) int
	At	func(p any, i int) any
	// Copy moves a whole structure or table of this type (tables cloned);
	// Zero clears one. Generated with the descriptor.
	Copy	func(dst, src any)
	Zero	func(p any)
	// Append adds an initial row to a standard table and returns it; nil
	// for a hashed table, whose rows only a keyed INSERT may add
	Append	func(p any) any
	// Delete removes row i (from 0) of a standard table; nil for a hashed one
	Delete	func(p any, i int)
	// New allocates a new initial value of this type and returns its
	// address (CREATE DATA through a descriptor, tables.go NewData)
	New	func() any
	// Name and DDIC: the type's name as the transpiler's runtime carries it
	// (abaplint's qualified name, upper case) and the dictionary type it
	// comes from, for RTTI's absolute names (rtti.go); empty when the
	// front end gave none (ultra/json)
	Name	string
	DDIC	string
}

var named sync.Map

// Named is an elementary descriptor with a type name: a type of its own,
// one per base type and names, made once (emit-go hoists each into a var).
func Named(base *Type, name, ddic string) *Type {
	key := [3]any{base, name, ddic}
	if t, ok := named.Load(key); ok {
		return t.(*Type)
	}
	c := *base
	c.Name, c.DDIC = name, ddic
	t, _ := named.LoadOrStore(key, &c)
	return t.(*Type)
}

type Comp struct {
	Name	string
	T	*Type
	Get	func(p any) any
}

// Data is a generic value, a field symbol TYPE any, or a data reference. P
// nil is an unassigned field symbol or an initial reference.
type Data struct {
	P	any
	T	*Type
	Valid	func() bool	// retained table-row reference; false after its row is deleted
}

// RowRef keeps the row's address, including when its table grows or shifts.
// A deleted row becomes an explicit dump on dereference.
func RowRef[T any](table *[]*T, row *T, typ *Type) Data {
	return Data{P: row, T: typ, Valid: func() bool {
		for _, current := range *table {
			if current == row {
				return true
			}
		}
		return false
	}}
}

func (d Data) Check() {
	if d.Valid != nil && !d.Valid() {
		panic(ArithmeticError{Class: "GETWA_NOT_ASSIGNED", Op: "reference to a deleted table row"})
	}
}

var (
	TI		= &Type{Kind: 'I', Len: 4}
	TInt8		= &Type{Kind: '8', Len: 8}
	TF		= &Type{Kind: 'F', Len: 8}
	TString		= &Type{Kind: 'g'}
	TXString	= &Type{Kind: 'y'}
	TD		= &Type{Kind: 'D', Len: 8}
	TT		= &Type{Kind: 'T', Len: 6}
	TRef		= &Type{Kind: 'l'}
)

var (
	sized	sync.Map
	sizedMu	sync.Mutex
)

func sizedType(kind byte, n int) *Type {
	key := string(kind) + ":" + itoa(n)
	if t, ok := sized.Load(key); ok {
		return t.(*Type)
	}
	sizedMu.Lock()
	defer sizedMu.Unlock()
	t, _ := sized.LoadOrStore(key, &Type{Kind: kind, Len: n})
	return t.(*Type)
}

// TC and TX are c and x of a length.
func TC(n int) *Type	{ return sizedType('C', n) }
func TX(n int) *Type	{ return sizedType('X', n) }

// TN is n of a length, carried as its digits.
func TN(n int) *Type	{ return sizedType('N', n) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// Component selects a name or 1-based int32 position; missing components return false.
func Component(d Data, name any) (Data, bool) {
	d.Check()
	if d.P == nil || d.T == nil || (d.T.Kind != 'u' && d.T.Kind != 'v') {
		return Data{}, false
	}
	index, positional := name.(int32)
	key, _ := name.(string)
	key = strings.ToUpper(strings.TrimRight(key, " "))
	for i, c := range d.T.Comps {
		if (positional && index == int32(i+1)) || (!positional && c.Name == key) {
			return Data{P: c.Get(d.P), T: c.T, Valid: d.Valid}, true
		}
	}
	return Data{}, false
}

// Lines is lines( ) of a generic table.
func Lines(d Data) int {
	d.Check()
	if d.P == nil || d.T == nil || d.T.Kind != 'h' {
		panic(NotCompiled("lines( )", "of a generic value that is not a table"))
	}
	return d.T.Lines(d.P)
}

// DeleteIndex is DELETE <generic table> INDEX i: false (sy-subrc 4) when
// there is no row i, as for a typed table.
func DeleteIndex(d Data, i int32) bool {
	n := Lines(d)
	if d.T.Delete == nil {
		panic(NotCompiled("DELETE ... INDEX", "of a generic table that is not a standard table"))
	}
	if i < 1 || int(i) > n {
		return false
	}
	d.T.Delete(d.P, int(i-1))
	BumpTable(d.P)
	return true
}

// AppendData is APPEND v TO a generic standard table: a new row, v moved
// into it; the new row's index (sy-tabix)
func AppendData(t, v Data) int {
	n := Lines(t)
	if t.T.Append == nil {
		panic(NotCompiled("APPEND", "to a generic table that is not a standard table"))
	}
	row := t.T.Append(t.P)
	BumpTable(t.P)
	if v.T == t.T.Row && t.T.Row.Copy != nil {
		t.T.Row.Copy(row, v.P)
	} else {
		MoveData(Data{P: row, T: t.T.Row}, v)
	}
	return n + 1
}

// Row is row i (from 0) of a generic table, bound to the row itself.
func Row(d Data, i int) Data {
	row := d.T.At(d.P, i)
	version := tableVersion(d.P)
	return Data{P: row, T: d.T.Row, Valid: func() bool {
		return tableVersion(d.P) == version && i < d.T.Lines(d.P) && d.T.At(d.P, i) == row
	}}
}

// DataString is a generic elementary value moved into a string.
func DataString(d Data) string {
	d.Check()
	switch d.T.Kind {
	case 'g', 'C', 'D', 'T', 'N':
		return *d.P.(*string)
	case 'X', 'y':
		return XToHex(*d.P.(*string))
	case 'I':
		return IToString(*d.P.(*int32))
	case 'P':
		return PToString(*d.P.(*string), d.T.Len%100)
	}
	panic(NotCompiled("move", "a generic value of type kind "+string(d.T.Kind)+" into a string"))
}
// DataI is a generic value moved into an i.
func DataI(d Data) int32 {
	d.Check()
	if d.T.Kind == 'I' {
		return *d.P.(*int32)
	}
	panic(NotCompiled("move", "a generic value of type kind "+string(d.T.Kind)+" into an i"))
}
// FmtData is a generic value in a string template.
func FmtData(d Data) string {
	d.Check()
	switch d.T.Kind {
	case 'I':
		return FmtI(*d.P.(*int32))
	case '8':
		return FmtI8(*d.P.(*int64))
	case 'F':
		return FmtF(*d.P.(*float64))
	case 'g', 'C', 'D', 'T', 'N':
		return *d.P.(*string)
	case 'X', 'y':
		return XToHex(*d.P.(*string))
	case 'P':
		return FmtP(*d.P.(*string), d.T.Len%100)
	}
	panic(NotCompiled("string template", "a generic value of type kind "+string(d.T.Kind)))
}

// DataP is a generic elementary value as a packed value (exact, not yet
// fitted to a field): the conversions of go/abap packed.go
func DataP(d Data) string {
	d.Check()
	switch d.T.Kind {
	case 'P':
		return *d.P.(*string)
	case 'I':
		return IToP(*d.P.(*int32))
	case '8':
		return IToP(*d.P.(*int64))
	case 'F':
		return FToP(*d.P.(*float64))
	case 'C', 'g', 'N':
		return CToP(*d.P.(*string))
	}
	panic(NotCompiled("move", "a generic value of type kind "+string(d.T.Kind)+" into a p"))
}

// IsInitialData is IS INITIAL of a generic value.
func IsInitialData(d Data) bool {
	d.Check()
	if d.P == nil {
		return true
	}
	switch d.T.Kind {
	case 'I':
		return *d.P.(*int32) == 0
	case '8':
		return *d.P.(*int64) == 0
	case 'F':
		return *d.P.(*float64) == 0
	case 'g', 'y', 'C':
		return *d.P.(*string) == ""
	case 'D':
		v := *d.P.(*string)
		return v == "" || v == "00000000"
	case 'T':
		v := *d.P.(*string)
		return v == "" || v == "000000"
	case 'N':
		return strings.Trim(*d.P.(*string), "0") == ""
	case 'X':
		return strings.Trim(*d.P.(*string), "\x00") == ""
	case 'P':
		v := strings.TrimLeft(strings.ReplaceAll(*d.P.(*string), ".", ""), "0-")
		return v == ""
	case 'h':
		return d.T.Lines(d.P) == 0
	case 'u', 'v':
		for _, c := range d.T.Comps {
			if !IsInitialData(Data{P: c.Get(d.P), T: c.T}) {
				return false
			}
		}
		return true
	case 'l':
		return d.P.(*Data).P == nil
	}
	panic(NotCompiled("IS INITIAL", "a generic value of type kind "+string(d.T.Kind)))
}

// Condense is CONDENSE: leading and trailing blanks go and every run of
// blanks inside becomes one; NO-GAPS removes every blank.
func Condense(s string, noGaps bool) string {
	if noGaps {
		return Canon(strings.ReplaceAll(s, " ", ""))
	}
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == ' ' }), " ")
}

// TObj is an object reference inside a structure seen generically.
var TObj = &Type{Kind: 'r'}

// DataBound is IS BOUND when a reference has crossed a TYPE any parameter.
// The generic binding points at the reference slot, so its own P is non-nil
// even when the reference held in that slot is initial.
func DataBound(d Data) bool {
	d.Check()
	if d.P == nil || d.T == nil {
		return false
	}
	switch d.T.Kind {
	case 'l':
		return d.P.(*Data).P != nil
	case 'r':
		v := reflect.ValueOf(d.P)
		return v.Kind() == reflect.Pointer && !v.IsNil() && !refNil(v.Elem().Interface())
	default:
		panic(NotCompiled("IS BOUND", "a generic value of type kind "+string(d.T.Kind)))
	}
}

// TP is p of a length and number of decimals, Len = n*100 + dec. A p value
// is carried as its decimal text with its decimals (packed.go).
func TP(n, dec int) *Type	{ return sizedType('P', n*100+dec) }

// InitialCh is IS INITIAL of a d, t or n value: "" (a structure field never
// set) or its typed zero.
func InitialCh(v, zero string) bool	{ return v == "" || v == zero }

// IsInitialOf is IS INITIAL of a typed value through its descriptor, for a
// structure whose initial value is not Go's zero value.
func IsInitialOf[T any](v T, t *Type) bool	{ return IsInitialData(Data{P: &v, T: t}) }

// InsertData is INSERT v INTO TABLE <generic table> (ultra/json): a
// standard table takes the row at the end, as INSERT INTO TABLE does to a
// typed one; another kind of table is refused, its key rules not being
// carried by the descriptor.
func InsertData(t, v Data) {
	if t.P == nil {
		panic(notAssigned("INSERT INTO TABLE"))
	}
	if t.T.Kind != 'h' {
		panic(NotCompiled("INSERT INTO TABLE", "a generic value that is not a table"))
	}
	if t.T.Append == nil {
		panic(NotCompiled("INSERT INTO TABLE", "a generic table that is not a standard table"))
	}
	AppendData(t, v)
}

// NewLine is CREATE DATA ref LIKE LINE OF <generic table> (ultra/json): a
// new initial row of the table's line type.
func NewLine(t Data) Data {
	if t.P == nil {
		panic(notAssigned("CREATE DATA LIKE LINE OF"))
	}
	if t.T.Kind != 'h' {
		panic(NotCompiled("CREATE DATA LIKE LINE OF", "a generic value that is not a table"))
	}
	return NewData(t.T.Row)
}

// AppendInitialData is APPEND INITIAL LINE TO <generic table> ASSIGNING <fs>
// (ultra/events): the new row bound, and its index (sy-tabix).
func AppendInitialData(t Data) (Data, int) {
	n := Lines(t)
	if t.T.Append == nil {
		panic(NotCompiled("APPEND INITIAL LINE", "to a generic table that is not a standard table"))
	}
	t.T.Append(t.P)
	BumpTable(t.P)
	return Row(t, n), n + 1
}

// DescrLength is cl_abap_typedescr=>describe_by_data( x )->length: the
// length in bytes, two per character of c and n (a Unicode system). Other
// kinds are not measured here and refused.
func DescrLength(d Data) int32 {
	if d.T == nil {
		panic(NotCompiled("describe_by_data( )->length", "of an unassigned field symbol"))
	}
	switch d.T.Kind {
	case 'C', 'N':
		return int32(2 * d.T.Len)
	case 'X':
		return int32(d.T.Len)
	case 'I':
		return 4
	}
	panic(NotCompiled("describe_by_data( )->length", "of type kind "+string(d.T.Kind)))
}
