//go:build profilingroutes

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"osg/gogen/abap"
	"osg/gogen/profiling"
	"path/filepath"
	"runtime/pprof"
	"strings"
	"testing"
)

// Requires the full OSGo generation; run with -tags profilingroutes.
func TestDispatcherProfileRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path, want string }{
		{"DELETE", "/sap/bc/adt/core/http/sessions/opaque-session", "/sap/bc/adt/core/http/sessions/:id"},
		{"GET", "/sap/bc/adt/ddic/tables/opaque-object", "/sap/bc/adt/ddic/tables/:name"},
		{"GET", "/users/opaque", "unmatched"},
		{"GET", "/sap/opu/odata/sap/ZPROFILE_SRV/Users('opaque-key')", "/sap/opu/odata/sap/ZPROFILE_SRV/Users"},
		{"GET", "/sap/opu/odata/sap/ZPROFILE_SRV/opaque-entity", "unmatched"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			h := profiling.HTTP(true, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				s := &abap.Session{ProfileRoute: func(template string) { profiling.Matched(r, template) }}
				// Install a registered model without requiring database boot.
				St_ZCL_STG_MODEL_INFO(s).gt_services = []ZCL_STG_MODEL_INFO__TY_SERVICE{{
					name: "ZPROFILE_SRV", entity_sets: []*ZCL_STG_MODEL_INFO__TY_ENTITY_SET{{name: "Users"}},
				}}
				// A matched handler may need database/host services after routing. Its
				// label has already been decided; those execution failures are irrelevant.
				func() {
					defer func() { _ = recover() }()
					if strings.HasPrefix(tc.path, odataBase) {
						ZCL_STG_DISPATCHER_DISPATCH(s, tc.method, tc.path, new([]*IHTTPNVP), "", "", "", "")
					} else {
						req := ZIF_OSD_ADT_ROUTE__TY_REQUEST{method: tc.method, path: tc.path}
						ZCL_OSD_ADT_ROUTER_DISPATCH(s, &req, new([]ZCL_OSD_ADT_ROUTER__TY_ROUTE))
					}
				}()
				got, _ := pprof.Label(r.Context(), "path")
				if got != tc.want {
					t.Fatalf("label %q, want %q", got, tc.want)
				}
			}))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
		})
	}
}

func TestRejectedRequestProfile(t *testing.T) {
	h := profiling.HTTP(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		icfHandler("ZCL_OSD_ADT_HANDLER", "/sap/bc/adt", adtDump)(w, r)
		got, _ := pprof.Label(r.Context(), "path")
		if got != "unmatched" {
			t.Fatalf("rejected label %q", got)
		}
	}))
	r := httptest.NewRequest("POST", "/sap/bc/adt/opaque", strings.NewReader("invalid compressed body"))
	r.Header.Set("Content-Encoding", "gzip")
	r.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("status %d", w.Code)
	}
}

func TestStaticProfilePrefix(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opaque.txt"), []byte("asset"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/app/opaque.txt", "/app"},
		{"GET", "/app/missing-opaque.txt", "unmatched"},
		{"POST", "/app/opaque.txt", "unmatched"},
	} {
		h := profiling.HTTP(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			serveStatic("/app", dir, notFound)(w, r)
			got, _ := pprof.Label(r.Context(), "path")
			if got != tc.want {
				t.Fatalf("%s %s: %q, want %q", tc.method, tc.path, got, tc.want)
			}
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
	}
}
