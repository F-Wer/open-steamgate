package profiling

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime/pprof"
	"strconv"
	"strings"
	"testing"
)

func TestSelected(t *testing.T) {
	for _, tc := range []struct {
		flag    bool
		env     map[string]string
		enabled bool
		address string
	}{
		{false, nil, false, "127.0.0.1:6060"},
		{true, nil, true, "127.0.0.1:6060"},
		{false, map[string]string{"OSD_PPROF": "1"}, true, "127.0.0.1:6060"},
		{false, map[string]string{"OSD_PPROF": "0"}, false, "127.0.0.1:6060"},
		{false, map[string]string{"OSGO_PPROF": "6061"}, true, "6061"},
	} {
		c := Selected(tc.flag, "", func(k string) string { return tc.env[k] })
		if c.Enabled != tc.enabled || c.Address != tc.address {
			t.Fatalf("%+v: %+v", tc, c)
		}
	}
	if c := Selected(false, "127.0.0.1:0", func(string) string { return "" }); c.Enabled {
		t.Fatal("address alone enabled profiles")
	}
}

func TestDisabledAndIsolation(t *testing.T) {
	c := Config{false, "0.0.0.0:0"}
	s, ln, err := c.Start()
	if s != nil || ln != nil || err != nil {
		t.Fatal("disabled profiler opened or validated a listener")
	}
	// Application listener is public, profiler remains separate and loopback.
	// osd-bind-allow: test intentionally proves wildcard service isolation
	appLn, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	app := &http.Server{Handler: HTTP(true, http.NotFoundHandler())}
	go app.Serve(appLn)
	defer app.Close()
	for _, enabled := range []bool{false, true} {
		h := HTTP(enabled, http.NotFoundHandler())
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/debug/pprof/", nil))
		if w.Code != 404 {
			t.Fatalf("enabled=%v app exposed profiler", enabled)
		}
	}
	u := "http://127.0.0.1:" + strconv.Itoa(appLn.Addr().(*net.TCPAddr).Port)
	resp, err := http.Get(u + "/debug/pprof/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatal("wildcard application exposed pprof")
	}
}

func TestLoopbackEndpoints(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", "[::]:0", "192.0.2.1:0", "example.invalid:0", "127.0.0.1:no"} {
		if _, ln, err := (Config{true, addr}).Start(); err == nil {
			ln.Close()
			t.Fatalf("accepted %s", addr)
		}
	}
	for _, addr := range []string{"[::1]:0", "127.0.0.1:0", ":0", "0", "localhost:0"} {
		s, ln, err := (Config{true, addr}).Start()
		if err != nil {
			t.Fatal(err)
		}
		if !ln.Addr().(*net.TCPAddr).IP.IsLoopback() {
			t.Fatal(ln.Addr())
		}
		go s.Serve(ln)
		for _, path := range []string{"", "cmdline", "symbol", "heap", "goroutine", "allocs", "block", "mutex"} {
			r, err := http.Get("http://" + ln.Addr().String() + "/debug/pprof/" + path)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			if r.StatusCode != 200 {
				t.Fatalf("%s: %d", path, r.StatusCode)
			}
		}
		s.Close()
	}
}

func TestHTTPLabels(t *testing.T) {
	h := HTTP(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		labels := map[string]string{}
		pprof.ForLabels(r.Context(), func(k, v string) bool { labels[k] = v; return true })
		if !reflect.DeepEqual(labels, map[string]string{"method": "POST", "path": "/odata/a%20b"}) {
			t.Fatalf("labels: %v", labels)
		}
		// A goroutine profile carries the live goroutine labels, not merely context values.
		var buf byteWriter
		pprof.Lookup("goroutine").WriteTo(&buf, 1)
		if !contains(buf.b, `"method":"POST"`) || !contains(buf.b, `"path":"/odata/a%20b"`) {
			t.Fatalf("goroutine labels absent: %s", buf.b)
		}
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/odata/a%20b?secret=hidden", nil))
}

type byteWriter struct{ b []byte }

func (b *byteWriter) Write(p []byte) (int, error) { b.b = append(b.b, p...); return len(p), nil }
func contains(b []byte, s string) bool            { return strings.Contains(string(b), s) }

func TestReportLabelsAndRestore(t *testing.T) {
	work := func() {
		var buf byteWriter
		pprof.Lookup("goroutine").WriteTo(&buf, 1)
		if !contains(buf.b, `"report":"ZDEMO"`) || !contains(buf.b, `"job":"nightly"`) {
			t.Fatal("report/job labels absent")
		}
	}
	Report(true, "ZDEMO", "nightly", work)()
	ctx := context.Background()
	if v, _ := pprof.Label(ctx, "report"); v != "" {
		t.Fatal("labels leaked")
	}
}

func TestDisabledZeroAllocations(t *testing.T) {
	h := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	wrapped := HTTP(false, h)
	if reflect.ValueOf(wrapped).Pointer() != reflect.ValueOf(h).Pointer() {
		t.Fatal("disabled HTTP wrapper installed")
	}
	r, w := httptest.NewRequest("GET", "/a?b=c", nil), httptest.NewRecorder()
	bare := testing.AllocsPerRun(1000, func() { h.ServeHTTP(w, r) })
	off := testing.AllocsPerRun(1000, func() { wrapped.ServeHTTP(w, r) })
	if off != bare || off != 0 {
		t.Fatalf("bare=%g disabled=%g", bare, off)
	}
	work := func() {}
	if reflect.ValueOf(Report(false, "ZDEMO", "job", work)).Pointer() != reflect.ValueOf(work).Pointer() {
		t.Fatal("disabled report wrapper installed")
	}
	t.Logf("bare=%g disabled=%g allocs/request; identical handler", bare, off)
}

func BenchmarkHTTP(b *testing.B) {
	h := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	r, w := httptest.NewRequest("GET", "/odata?query=omitted", nil), httptest.NewRecorder()
	for _, name := range []string{"bare", "disabled", "enabled"} {
		next := http.Handler(h)
		if name != "bare" {
			next = HTTP(name == "enabled", h)
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				next.ServeHTTP(w, r)
			}
		})
	}
}

func TestHTTPPathNormalization(t *testing.T) {
	for _, tc := range []struct{ path, want string }{
		{"/sap/bc/adt/core/http/sessions/opaque-session", "/sap/bc/adt/core/http/sessions/{id}"},
		{"/sap/bc/adt/core/http/sessions", "/sap/bc/adt/core/http/sessions"},
		{"/odata/Users('example')", "/odata/Users{key}"},
		{"/odata/Users(42)", "/odata/Users{key}"},
		{"/odata/Users(Name='example',Number=42)/Items", "/odata/Users{key}/Items"},
		{"/odata/Users(Number=42,Other=7)", "/odata/Users{key}"},
		{"/odata/Users%28%27example%27%29", "/odata/Users{key}"},
		{"/odata/Users('example)secret')/Items(7)", "/odata/Users{key}/Items{key}"},
		{"/odata/Users('example/secret')/Items", "/odata/Users{key}/Items"},
		{"/odata/Users('example''s)secret')", "/odata/Users{key}"},
		{"/odata/Users%28%27example%29secret%27%29", "/odata/Users{key}"},
		{"/odata/Users('unclosed", "/odata/Users{key}"},
		{"/odata/$batch", "/odata/$batch"},
		{"/plain/path", "/plain/path"},
		{"/items/42", "/items/{id}"},
		{"/items/'example'", "/items/{id}"},
		{"/items/" + strings.Join([]string{strings.Repeat("a", 8), "bbbb", "cccc", "dddd", strings.Repeat("e", 12)}, "-"), "/items/{id}"},
		{"/items/12345678123412341234123456789abc", "/items/{id}"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			h := HTTP(true, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				got, _ := pprof.Label(r.Context(), "path")
				if got != tc.want {
					t.Fatalf("path = %q, want %q", got, tc.want)
				}
			}))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", tc.path, nil))
		})
	}
	r := httptest.NewRequest("GET", "/items/opaque", nil)
	r.Pattern = "GET /items/{id}"
	if got := labelPath(r); got != "/items/{id}" {
		t.Fatal(got)
	}
}
