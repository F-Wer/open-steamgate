// SPDX-License-Identifier: MIT

// Package profiling owns opt-in native host profiles and execution labels.
package profiling

import (
	"context"
	"fmt"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"runtime/pprof"
	"strconv"
	"strings"
	"time"
)

// Config is selected once at startup. Legacy OSGO_PPROF also opts in.
type Config struct {
	Enabled bool
	Address string
}

func Selected(flag bool, address string, getenv func(string) string) Config {
	legacy := getenv("OSGO_PPROF")
	enabled := flag || getenv("OSD_PPROF") == "1" || legacy != ""
	if address == "" {
		address = legacy
	}
	if address == "" {
		address = "127.0.0.1:6060"
	}
	return Config{enabled, address}
}

// Start never registers on the application mux. Only numeric loopback
// addresses are accepted, avoiding hostname resolution and wildcard binds.
// Disabled configuration does not validate, allocate a mux or open a socket.
func (c Config) Start() (*http.Server, net.Listener, error) {
	if !c.Enabled {
		return nil, nil, nil
	}
	a := strings.TrimSpace(c.Address)
	if !strings.Contains(a, ":") {
		a = "127.0.0.1:" + a
	}
	host, port, err := net.SplitHostPort(a)
	if host == "" || host == "localhost" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	n, e := strconv.Atoi(port)
	if err != nil || e != nil || n < 0 || n > 65535 || ip == nil || !ip.IsLoopback() {
		return nil, nil, fmt.Errorf("pprof refused %q: requires a numeric loopback address and port", c.Address)
	}
	// osd-bind-allow: ip was validated as numeric loopback above
	ln, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, nil, fmt.Errorf("pprof: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /debug/pprof/", httppprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("GET /debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("GET /debug/pprof/trace", httppprof.Trace)
	return &http.Server{Handler: mux, ReadHeaderTimeout: 30 * time.Second}, ln, nil
}

// HTTP returns the original handler when off: no branch, context copy or
// label allocation occurs on the disabled request path.
func HTTP(enabled bool, next http.Handler) http.Handler {
	if !enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pprof.Do(r.Context(), pprof.Labels("method", r.Method, "path", r.URL.EscapedPath()), func(ctx context.Context) {
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
}

// Report selects the execution function once, outside report/job execution.
// Callers pass the logical report and job names, never user or input data.
func Report(enabled bool, report, job string, next func()) func() {
	if !enabled {
		return next
	}
	labels := pprof.Labels("report", report)
	if job != "" {
		labels = pprof.Labels("report", report, "job", job)
	}
	return func() { pprof.Do(context.Background(), labels, func(context.Context) { next() }) }
}
