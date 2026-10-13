package abap

import "testing"

func TestExceptionReferenceBoundaries(t *testing.T) {
	if ExceptionRef(&Session{}, nil) != nil {
		t.Fatal("initial widening became bound")
	}
	if ExceptionPrevious(&Exception{Class: "CX_SY_ZERODIVIDE"}) != nil {
		t.Fatal("kernel leaf has a predecessor")
	}
	for _, test := range []struct {
		name  string
		call  func()
		class string
	}{
		{"unknown class", func() { ExceptionRef(&Session{}, &Exception{Class: "CX_UNCOMPILED_TEST"}) }, "NOT_COMPILED"},
		{"initial text", func() { (*Exception)(nil).TextOf(&Session{}) }, "OBJECTS_OBJREF_NOT_ASSIGNED"},
		{"initial class", func() { ExceptionClass(nil) }, "OBJECTS_OBJREF_NOT_ASSIGNED"},
		{"initial dereference", func() { ExceptionPrevious(nil) }, "OBJECTS_OBJREF_NOT_ASSIGNED"},
		{"object without root", func() { ExceptionPrevious(&Exception{Class: "CX_TEST", Obj: new(int)}) }, "NOT_COMPILED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			defer func() {
				e, ok := AsError(recover())
				if !ok || e.Class != test.class {
					t.Fatalf("wanted %s, got %#v", test.class, e)
				}
			}()
			test.call()
			t.Fatal("expected a named refusal or dump")
		})
	}
}

type kernelReadProbe struct{ kernel *Exception }

func (x *kernelReadProbe) GetKernelException() *Exception { return x.kernel }
func TestKernelAttributeReads(t *testing.T) {
	obj := &kernelReadProbe{kernel: &Exception{Class: "CX_SY_ZERODIVIDE"}}
	for _, member := range []string{"TEXTID", "KERNEL_ERRID", "ANY_CX_ATTRIBUTE"} {
		t.Run(member, func(t *testing.T) {
			defer func() {
				e, ok := AsError(recover())
				if !ok || e.Class != "NOT_COMPILED" {
					t.Fatalf("wanted named refusal, got %#v", e)
				}
			}()
			ExceptionRead(obj, member)
			t.Fatal("unpopulated attribute read succeeded")
		})
	}
	if ExceptionRead(obj, "PREVIOUS") != obj || ExceptionRead(obj, "") != obj {
		t.Fatal("populated readers lost identity")
	}
	obj.kernel = nil
	if ExceptionRead(obj, "TEXTID") != obj {
		t.Fatal("compiled metadata lost identity")
	}
}

func TestCaughtExceptionRethrowIdentity(t *testing.T) {
	e := CaughtException(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "division"})
	for i := 0; i < 3; i++ {
		r := Raise(e, "")
		wrapped := &Rethrown{V: r}
		if CaughtException(wrapped) != e || !Catchable(wrapped) {
			t.Fatal("rethrow lost the lazy carrier")
		}
		if got, ok := AsError(wrapped); !ok || got.Class != e.Class || got.Op != e.Op {
			t.Fatal("rethrow lost kernel error classification or text")
		}
	}
	r := Raise(e, "")
	// Widening an earlier catch after RAISE must also update the object view.
	e.Obj = new(int)
	got, ok := AsRaised(r)
	if !ok || got.Obj != e.Obj || CaughtException(r) != e {
		t.Fatal("rethrow lost the materialised object")
	}
}
