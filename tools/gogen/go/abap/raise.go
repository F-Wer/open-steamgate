package abap

import (
	"fmt"
	"reflect"
	"runtime/debug"
	"sync"
)

// Raised is RAISE EXCEPTION of a class-based exception: the object itself
// and the name of its class. It travels as a Go panic like the runtime's
// own exceptions (ArithmeticError). A rethrow keeps the caught carrier even
// before its compiled object is materialised.
type Raised struct {
	Obj   any
	Class string
	// Caught keeps the lazy materialisation shared across CATCH and rethrow.
	Caught *Exception
	// AssertionQuitNo records the QUIT value of the call that raised this
	// assertion, so a test runner can decide what its teardown does next.
	AssertionQuitNo bool
}

// WithAssertQuit attaches the explicit QUIT value to an assertion failure.
func WithAssertQuit(quit int32, f func()) {
	defer func() {
		if x := recover(); x != nil {
			if r, ok := AsRaised(x); ok && r.Class == "KERNEL_CX_ASSERT" {
				r.AssertionQuitNo = quit == 0
			}
			panic(x)
		}
	}()
	f()
}

func (r *Raised) Error() string {
	if r.Caught != nil && r.Caught.Obj == nil {
		return r.Caught.Text()
	}
	if r.Class == "KERNEL_CX_ASSERT" {
		if x, ok := r.Obj.(interface{ AssertionMessage() string }); ok {
			return x.AssertionMessage()
		}
		v := reflect.ValueOf(r.Obj)
		if v.IsValid() && v.Kind() == reflect.Pointer && !v.IsNil() {
			msg := v.Elem().FieldByName("Msg")
			if msg.IsValid() && msg.Kind() == reflect.String {
				return msg.String()
			}
		}
	}
	return "UNCAUGHT_EXCEPTION " + r.Class
}

var supers = map[string]string{}

// RegisterSupers is filled by the generated program: the superclass of every
// exception class it compiles, and of their ancestors.
func RegisterSupers(m map[string]string) {
	for k, v := range m {
		supers[k] = v
	}
}

// IsA: the class is ancestor or one of its subclasses.
func IsA(class, ancestor string) bool {
	for c, n := class, 0; c != "" && n < 40; c, n = supers[c], n+1 {
		if c == ancestor {
			return true
		}
	}
	return false
}

var (
	byTypeOnce sync.Once
	byType     map[reflect.Type]string
)

// ClassOf is the ABAP class of an object, by its Go type.
func ClassOf(obj any) string {
	byTypeOnce.Do(func() {
		byType = map[reflect.Type]string{}
		for n, c := range classes {
			byType[reflect.TypeOf(c.zero)] = n
		}
	})
	return byType[reflect.TypeOf(obj)]
}

// Raise makes the panic value of RAISE EXCEPTION. class is empty when only
// the object knows it (RAISE EXCEPTION obj). An initial reference is not
// raised: A4H aborts with "Access using a 'ZERO' object reference is not
// possible", which CATCH cx_root does not take (2026-09-23).
func Raise(obj any, class string) *Raised {
	if obj == nil || (reflect.ValueOf(obj).Kind() == reflect.Pointer && reflect.ValueOf(obj).IsNil()) {
		panic(ArithmeticError{Class: "OBJECTS_OBJREF_NOT_ASSIGNED", Op: "RAISE EXCEPTION of an initial reference"})
	}
	if e, ok := obj.(*Exception); ok {
		return &Raised{Obj: e.Obj, Class: e.Class, Caught: e}
	}
	if class == "" {
		class = ClassOf(obj)
		if class == "" {
			panic(NotCompiled("RAISE EXCEPTION", "the class of the object is not registered"))
		}
	}
	return &Raised{Obj: obj, Class: class}
}

// AsRaised is the exception object inside a recovered value, unwrapped.
func AsRaised(r any) (*Raised, bool) {
	if w, ok := r.(*Rethrown); ok {
		r = w.V
	}
	x, ok := r.(*Raised)
	if ok && x.Caught != nil {
		x.Obj = x.Caught.Obj
	}
	return x, ok
}

// ClassBased: a class-based exception (raised as an object or by the
// runtime), which passes a CLEANUP; not a dump (NOT_COMPILED, ASSERTION_FAILED,
// a classic exception).
func ClassBased(r any) bool {
	if _, ok := AsRaised(r); ok {
		return true
	}
	e, ok := AsError(r)
	return ok && len(e.Class) > 3 && e.Class[:3] == "CX_"
}

// Catchable reports whether an ABAP CATCH may handle a recovered value.
// Refusals and dumps travel as panics too, but are not ABAP exceptions.
func Catchable(r any) bool {
	if _, ok := AsRaised(r); ok {
		return true
	}
	e, ok := AsError(r)
	return ok && len(e.Class) > 3 && e.Class[:3] == "CX_"
}

// Texter is an exception object whose get_text( ) is compiled.
type Texter interface {
	IF_MESSAGE__GET_TEXT(s *Session) string
}

// TextOf is get_text( ) of an exception caught INTO a variable that also
// takes runtime exceptions: a raised object's own get_text, else the class
// and the operation.
func (e *Exception) TextOf(s *Session) string {
	if e == nil {
		notBound("GET_TEXT")
	}
	if e.Obj != nil {
		if t, ok := e.Obj.(Texter); ok {
			return t.IF_MESSAGE__GET_TEXT(s)
		}
		panic(NotCompiled(e.Class+"=>GET_TEXT", "get_text( ) of the class is not compiled"))
	}
	return e.Text()
}

// Handled: some TRY still active further out takes the exception. The kernel
// looks for a handler before it unwinds, and the CLEANUP blocks on the way run
// only when it finds one; an exception that nothing takes dumps at the RAISE
// with no CLEANUP run (A4H, RFC module with CLEANUPs writing committed rows,
// UNCAUGHT_EXCEPTION at the RAISE and no row, 2026-09-23).
func (s *Session) Handled(r any) bool {
	for i := len(s.Handlers) - 1; i >= 0; i-- {
		if s.Handlers[i](r) {
			return true
		}
	}
	return false
}

// CctorDump is an exception that left a class constructor: A4H ends the
// program with a runtime error there, whatever CATCH the user of the class
// has (ZCL_GOGEN_T_CCBOOM2, 2026-09-24: a CX_SY_ZERODIVIDE in the class
// constructor was a runtime abortion, not CX_SY_NO_HANDLER, and no CATCH
// took it). It is not class-based, so no CATCH and no CLEANUP sees it.
type CctorDump struct {
	Class string
	Cause any
}

func (e CctorDump) Error() string {
	return "RUNTIME_ERROR in " + e.Class + "=>CLASS_CONSTRUCTOR: " + fmt.Sprint(e.Cause)
}

// CctorGuard is deferred by Ensure_<class> (ultra/events fix round): a panic
// out of the class constructor clears the class's flag, so the next use
// runs it again as the next internal session would on a system (osgo keeps
// class data for the process), and a class-based exception becomes a
// CctorDump; anything else (NOT_COMPILED, a dump already) goes on as it is.
func CctorGuard(class string, done *bool) {
	r := recover()
	if r == nil {
		return
	}
	*done = false
	if ClassBased(r) {
		cause := r
		if w, ok := r.(*Rethrown); ok {
			cause = w.V
			panic(&Rethrown{V: CctorDump{Class: class, Cause: cause}, Stack: w.Stack})
		}
		Repanic(CctorDump{Class: class, Cause: cause}, debug.Stack())
	}
	panic(r)
}
