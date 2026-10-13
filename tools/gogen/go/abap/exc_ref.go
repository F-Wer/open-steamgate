package abap

// CaughtException retains the carrier of a rethrow, including its lazy object.
func CaughtException(r any) *Exception {
	if x, ok := AsRaised(r); ok {
		if x.Caught != nil {
			return x.Caught
		}
		return &Exception{Class: x.Class, Obj: x.Obj}
	}
	e, _ := AsError(r)
	return &Exception{Class: e.Class, Op: e.Op}
}

// ExceptionRef widens a caught value without inventing a surrogate CX type.
// Runtime classes must be compiled and have an optional constructor.
func ExceptionRef(s *Session, e *Exception) any {
	if e == nil {
		return nil
	}
	if e.Obj != nil {
		return e.Obj
	}
	c, ok := classes[e.Class]
	if !ok {
		panic(NotCompiled("exception widening", "REF TO "+e.Class+": the kernel class is not compiled"))
	}
	obj := c.make(s)
	root, ok := obj.(interface{ SetKernelException(*Exception) })
	if !ok {
		panic(NotCompiled("exception widening", e.Class+": CX_ROOT is not compiled"))
	}
	root.SetKernelException(e)
	e.Obj = obj
	return obj
}

// ExceptionPrevious reads a compiled CX_ROOT's PREVIOUS through its host seam.
// Kernel errors start without a predecessor; RAISE TYPE stores it on the object.
func ExceptionPrevious(e *Exception) *Exception {
	if e == nil {
		panic(ArithmeticError{Class: "OBJECTS_OBJREF_NOT_ASSIGNED", Op: "PREVIOUS"})
	}
	if e.Obj == nil {
		return nil
	}
	x, ok := e.Obj.(interface{ ExceptionPrevious() any })
	if !ok {
		panic(NotCompiled(e.Class+"->PREVIOUS", "CX_ROOT is not compiled"))
	}
	obj := x.ExceptionPrevious()
	if refNil(obj) {
		return nil
	}
	return &Exception{Class: ClassOf(obj), Obj: obj}
}

// ExceptionRead checks dereferences and refuses unmeasured kernel attributes.
// PREVIOUS is populated; SAP metadata values are unmeasured; measure on A4H.
func ExceptionRead[T any](obj T, member string) T {
	if refNil(obj) {
		notBound(member)
	}
	if x, ok := any(obj).(interface{ GetKernelException() *Exception }); ok && x.GetKernelException() != nil && member != "" && member != "PREVIOUS" {
		panic(NotCompiled("exception attribute "+member, "kernel metadata is unmeasured; measure on A4H"))
	}
	return obj
}

func ExceptionClass(e *Exception) string {
	if e == nil {
		notBound("GET_CLASS_NAME")
	}
	return "\\CLASS=" + e.Class
}

// ObjectRttiRead refuses enumeration only for a widened kernel descriptor.
func ObjectRttiRead[T any](obj T, member string) T {
	if refNil(obj) {
		notBound(member)
	}
	if x, ok := any(obj).(interface{ IsKernelRtti() bool }); ok && x.IsKernelRtti() {
		panic(NotCompiled("object RTTI member "+member, "enumeration is not implemented"))
	}
	return obj
}
