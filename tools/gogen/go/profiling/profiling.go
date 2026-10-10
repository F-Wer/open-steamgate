// SPDX-License-Identifier: MIT

// Package profiling owns opt-in native host profiles and execution labels.
package profiling

import (
	"context"
	"fmt"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"net/url"
	"regexp"
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
		pprof.Do(r.Context(), pprof.Labels("method", r.Method, "path", labelPath(r)), func(ctx context.Context) {
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
}

// The ABAP router is downstream of this host wrapper and does not expose
// its matched template here. Mirror its session-id position explicitly;
// other paths use conservative, syntactic identifier recognition.
var keyPredicate = regexp.MustCompile(`\([^)]*\)`)
var idSegment = regexp.MustCompile(`^(?:[0-9]+|[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|'.*'|".*")$`)

func labelPath(r *http.Request) string {
	path := r.URL.EscapedPath()
	// Hosts that already know a matched route may supply its template.
	if r.Pattern != "" {
		path = r.Pattern
		if i := strings.IndexByte(path, ' '); i >= 0 {
			path = path[i+1:]
		}
	}
	parts := strings.Split(path, "/")
	for i, part := range parts {
		decoded, err := url.PathUnescape(part)
		if err != nil {
			decoded = part
		}
		if i == 7 && strings.Join(parts[:i], "/") == "/sap/bc/adt/core/http/sessions" {
			parts[i] = "{id}"
		} else if idSegment.MatchString(decoded) {
			parts[i] = "{id}"
		} else if strings.Contains(decoded, "(") {
			// Drop malformed/unclosed predicates too, rather than exposing a key.
			cleaned := keyPredicate.ReplaceAllString(decoded, "{key}")
			if at := strings.IndexByte(cleaned, '('); at >= 0 {
				cleaned = cleaned[:at] + "{key}"
			}
			parts[i] = strings.ReplaceAll(url.PathEscape(cleaned), "%7Bkey%7D", "{key}")
		}
	}
	return strings.Join(parts, "/")
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
