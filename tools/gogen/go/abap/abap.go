// Package abap is the runtime the Go backend spike calls into: only what
// the generated code of tools/gogen/samples needs, with ABAP's semantics
// rather than Go's where the two differ.
//
// Values are plain Go values -- int32 for i, float64 for f, a slice for a
// standard table -- because the calculation type is decided by the
// front end (tools/gogen/frontend.mjs) and written into the IR. There is no
// type test at run time, which is the whole difference from the JS runtime,
// where every operation first finds out what its operands are.
package abap

import (
	"fmt"
	"math"
	"osg/gogen/abaperr"
	"osg/gogen/inflate"
	"strings"
)

// Sy holds the system fields one session writes. On a system they belong to
// the roll area; here they belong to the Session, so two sessions on two
// goroutines never see each other's sy-index.
type Sy struct {
	// Message fields belong to the dialog session, including classic FM exceptions.
	// Msgno is NUMC(3); MessageNumber supplies its initial value on access.
	Msgid, Msgno, Msgty        string
	Msgv1, Msgv2, Msgv3, Msgv4 string
	Index                      int32
	Tabix                      int32
	Subrc                      int32
	Fdpos                      int32
	// Dbcnt: the rows the last Open SQL statement read or wrote
	Dbcnt int32
}

// MessageNumber preserves NUMC(3)'s initial value, including reference reads.
func (sy *Sy) MessageNumber() *string {
	if sy.Msgno == "" {
		sy.Msgno = "000"
	}
	return &sy.Msgno
}

func (s *Session) EnqClient() string {
	if s == nil {
		return Mandt
	}
	return Mandt
}

func (s *Session) EnqSetSubrc(value int32) {
	if s == nil {
		return
	}
	s.Sy.Subrc = value
}

func (s *Session) EnqRefuse(call, why string) {
	panic(NotCompiled(call, why))
}

func (s *Session) EnqRaise(object, name, msgno, holder string) {
	if s != nil && msgno != "" {
		s.Sy.Msgid = "MC"
		s.Sy.Msgty = "E"
		s.Sy.Msgno = CToN(msgno, 3)
		s.Sy.Msgv1 = CFit(holder, 50)
	}
	panic(ClassicException{Name: name, Method: "ENQUEUE_" + strings.ToUpper(object)})
}

// Session is what a dialog step runs in. A goroutine picks one up, runs, and
// puts it down: nothing ties a Session to the goroutine that ran it last.
// Only one goroutine may use a Session at a time. Its zero value is ready to use.
type Session struct {
	// ProfileRoute receives only matched dispatcher templates / model names.
	// Nil when profiling is disabled or outside an HTTP request.
	ProfileRoute func(string)

	// Statics holds class attributes, constructor flags and event registrations. Nil creates a private
	// store on first access. Shared stores require serialized access.
	Statics *Statics
	Sy      Sy
	// UpdateTask records an update-task module called in this session LUW.
	UpdateTask bool
	// Handlers: the CATCH clauses of the TRYs active in this session,
	// outermost first, each asking whether it takes a recovered value. A
	// CLEANUP runs only when one of them does (see Handled).
	Handlers []func(any) bool
	// httpc: what Node keeps on each CL_HTTP_CLIENT object (its socket, the
	// headers and the answer of a SEND), by the object (httpc.go)
	// HoldsWorkProcess says this session's current dialog step owns WorkProcess.
	HoldsWorkProcess bool
	httpc            map[any]*httpcClient
	// inflate: the decoders of ZCL_OSD_INFLATE=>HOST_* by handle (inflate.go)
	inflate           *inflate.Registry
	localDestinations map[string]bool
	messageCall       MessageCall
}

// ArithmeticError retains the identity of errors from pure packages.
type ArithmeticError = abaperr.ArithmeticError

func overflow(op string) { panic(ArithmeticError{Class: "CX_SY_ARITHMETIC_OVERFLOW", Op: op}) }

func check(v int64, op string) int32 {
	if v > math.MaxInt32 || v < math.MinInt32 {
		overflow(op)
	}
	return int32(v)
}

// AddI, SubI, MulI: calculation type i, every intermediate result checked.
func AddI(a, b int32) int32 { return check(int64(a)+int64(b), "+") }
func SubI(a, b int32) int32 { return check(int64(a)-int64(b), "-") }
func MulI(a, b int32) int32 { return check(int64(a)*int64(b), "*") }
func NegI(a int32) int32    { return check(-int64(a), "-") }

// DivI is `/` with calculation type i: the exact quotient rounded half away
// from zero (7 / 2 = 4, -7 / 2 = -4), and 0 / 0 = 0, which ABAP defines.
func DivI(a, b int32) int32 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
	}
	n, d := int64(a), int64(b)
	q := n / d
	r := n % d
	if 2*abs64(r) >= abs64(d) {
		if (n < 0) != (d < 0) {
			q--
		} else {
			q++
		}
	}
	return check(q, "/")
}

// DivIntI and ModI are DIV and MOD: the remainder is never negative, so
// a = b * (a DIV b) + (a MOD b) with 0 <= a MOD b < |b|.
func DivIntI(a, b int32) int32 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "DIV"})
	}
	n, d := int64(a), int64(b)
	r := n % d
	if r < 0 {
		r += abs64(d)
	}
	return check((n-r)/d, "DIV")
}

func ModI(a, b int32) int32 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "MOD"})
	}
	n, d := int64(a), int64(b)
	r := n % d
	if r < 0 {
		r += abs64(d)
	}
	return int32(r)
}

// DivF: `/` with calculation type f; ABAP raises on a zero divisor too,
// except for 0 / 0.
func DivF(a, b float64) float64 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
	}
	return a / b
}

// DivIntF and ModF: DIV and MOD in f, same non-negative remainder rule.
func DivIntF(a, b float64) float64 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "DIV"})
	}
	r := math.Mod(a, b)
	if r < 0 {
		r += math.Abs(b)
	}
	return (a - r) / b
}

func ModF(a, b float64) float64 {
	if b == 0 {
		if a == 0 {
			return 0
		}
		panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "MOD"})
	}
	r := math.Mod(a, b)
	if r < 0 {
		r += math.Abs(b)
	}
	return r
}

// F2I converts f to i: rounded half away from zero, and a value outside the
// range of i is an overflow, not a wrap.
func F2I(f float64) int32 {
	r := math.Round(f) // math.Round is half away from zero
	if math.IsNaN(r) || r > math.MaxInt32 || r < math.MinInt32 {
		panic(ArithmeticError{Class: "CX_SY_CONVERSION_OVERFLOW", Op: "f->i"})
	}
	return int32(r)
}

func AbsI(a int32) int32 { return check(abs64(int64(a)), "abs") }

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// Exception is what CATCH ... INTO receives: the class and where it was
// raised. Text is not the system's message text (not measured).
type Exception struct {
	Class string
	Op    string
	Obj   any // the object of a RAISE EXCEPTION, nil for the runtime's own
}

func (e *Exception) Text() string { return e.Class + " in " + e.Op }

// Ptr passes a value that is not a variable where a pointer is expected (a
// composite IMPORTING by reference given an expression).
func Ptr[T any](v T) *T { return &v }

// Rethrown is a panic a TRY did not catch and passed on, with the stack of
// where it was first raised (a re-panic would otherwise report the TRY).
type Rethrown struct {
	V     any
	Stack string
}

func (r *Rethrown) Error() string { return fmt.Sprint(r.V) }

// Repanic passes an uncaught panic on, keeping its first stack.
func Repanic(r any, stack []byte) {
	if _, ok := r.(*Rethrown); ok {
		panic(r)
	}
	// the stack is taken in the TRY's deferred function: what is above the
	// panic frame is that function, whose line is the end of the method,
	// so the stack starts at the frame that raised
	st := string(stack)
	if i := strings.Index(st, "\npanic("); i >= 0 {
		if j := strings.Index(st[i+1:], "\n\t"); j >= 0 {
			if k := strings.Index(st[i+1+j+2:], "\n"); k >= 0 {
				st = st[:strings.Index(st, "\n")+1] + st[i+1+j+2+k+1:]
			}
		}
	}
	panic(&Rethrown{V: r, Stack: st})
}

// AsError is the ABAP exception inside a recovered value, unwrapped.
func AsError(r any) (ArithmeticError, bool) {
	if w, ok := r.(*Rethrown); ok {
		r = w.V
	}
	e, ok := r.(ArithmeticError)
	return e, ok
}
