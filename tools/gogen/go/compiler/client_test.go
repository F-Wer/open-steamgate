package compiler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"runtime/pprof"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("COMPILER_FAKE"); mode != "" {
		if mode == "descendant" {
			marker := os.Getenv("COMPILER_MARKER")
			if err := os.WriteFile(marker, []byte("ready"), 0600); err != nil {
				os.Exit(9)
			}
			if err := os.WriteFile(marker+".pid", []byte(fmt.Sprint(os.Getpid())), 0600); err != nil {
				os.Exit(9)
			}
			for {
				_ = os.WriteFile(os.Getenv("COMPILER_MARKER"), []byte(fmt.Sprint(time.Now().UnixNano())), 0600)
				time.Sleep(5 * time.Millisecond)
			}
		}
		reader := bufio.NewReader(os.Stdin)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				break
			}
			var request struct {
				ID       uint64 `json:"id"`
				Op       string `json:"op"`
				Contract int    `json:"contract"`
				OSGO     string `json:"osgo"`
				Root     string `json:"root"`
			}
			if json.Unmarshal(line, &request) != nil {
				os.Exit(3)
			}
			response := map[string]any{"id": request.ID}
			if request.Op == "hello" {
				if request.ID != 0 || request.Contract != 1 || request.OSGO != "test-version" || request.Root != "test-root" {
					os.Exit(4)
				}
				contract := 1
				if mode == "mismatch" {
					contract = 2
				}
				caps := []string{"check"}
				if mode == "unsupported" {
					caps = []string{}
				}
				response["contract"], response["osd"], response["transpiler"] = contract, "test-osd", "test-pin"
				response["capabilities"], response["limits"] = caps, Limits{4 * 1024 * 1024, 1}
				if mode == "small-snapshot" {
					response["limits"] = Limits{1024, 1}
				}
				if mode == "descendant-exit" {
					startDescendant()
				}
				if field, ok := strings.CutPrefix(mode, "hello-missing:"); ok {
					delete(response, field)
				}
				if limits, ok := strings.CutPrefix(mode, "limits:"); ok {
					response["limits"] = json.RawMessage(limits)
				}
				if mode == "other-pin" {
					response["transpiler"] = "other-pin"
				}
			} else {
				response["diagnostics"] = []Diagnostic{}
				response["registryHash"], response["configSha"], response["inputCount"] = strings.Repeat("a", 64), strings.Repeat("b", 64), 2
				if marker := os.Getenv("COMPILER_MARKER"); marker != "" && mode != "descendant-exit" {
					_ = os.WriteFile(marker, []byte("sent"), 0600)
				}
				switch {
				case mode == "close-stdout" || mode == "malformed-alive":
					if mode == "malformed-alive" {
						_, _ = io.WriteString(os.Stdout, "broken\n")
					}
					_ = os.Stdout.Close()
					time.Sleep(time.Hour)
				case mode == "descendant-exit":
					os.Exit(0)
				case mode == "fragmented" || mode == "large" || mode == "small-snapshot":
					response["diagnostics"] = []Diagnostic{{Text: strings.Repeat("x", 128*1024)}}
					raw, _ := json.Marshal(response)
					if mode == "fragmented" {
						for i := 0; i < len(raw); i += 997 {
							end := min(i+997, len(raw))
							_, _ = os.Stdout.Write(raw[i:end])
						}
						_, _ = io.WriteString(os.Stdout, "\n")
					} else {
						_, _ = os.Stdout.Write(append(raw, '\n'))
					}
					continue
				case mode == "stderr-flood":
					_, _ = io.WriteString(os.Stderr, strings.Repeat("log", 1024*1024))
					response["diagnostics"] = []Diagnostic{}
				case mode == "answer-exit":
					response["diagnostics"] = []Diagnostic{}
					_ = json.NewEncoder(os.Stdout).Encode(response)
					_ = os.Stdout.Close()
					os.Exit(0)
				case mode == "timeout":
					time.Sleep(time.Hour)
				case mode == "crash":
					os.Exit(5)
				case strings.HasPrefix(mode, "refuse:"):
					response["error"] = &Refusal{strings.TrimPrefix(mode, "refuse:"), "test refusal"}
				case mode == "bad-id":
					response["id"] = request.ID + 1
				default:
					response["diagnostics"] = []Diagnostic{{Severity: "E", Code: "ABAP_SYNTAX", Text: "fixture", Object: ObjectID{"CLAS", "ZCL_FIXTURE"}, Include: "src/fixture.clas.abap", Line: 3, Col: 12, EndLine: 3, EndCol: 42}}
					response["registryHash"], response["configSha"], response["inputCount"], response["virtualFiles"] = strings.Repeat("a", 64), strings.Repeat("b", 64), 2, []string{"virtual"}
				}
				if field, ok := strings.CutPrefix(mode, "check-missing:"); ok {
					delete(response, field)
				}
				if spec, ok := strings.CutPrefix(mode, "check-invalid:"); ok {
					field, raw, _ := strings.Cut(spec, "=")
					response[field] = json.RawMessage(raw)
				}
			}
			_ = json.NewEncoder(os.Stdout).Encode(response)
			if request.Op == "hello" && mode == "idle-descendant-exit" {
				startDescendant()
				os.Exit(0)
			}
			if request.Op == "hello" && mode == "idle-close" {
				_ = os.Stdout.Close()
				time.Sleep(time.Hour)
			}
			if request.Op == "hello" && mode == "blocked-write" {
				time.Sleep(time.Hour)
			}
		}
		os.Exit(0)
	}
	enableDescendantReaping()
	os.Exit(m.Run())
}

func fake(t *testing.T, mode string) *Client {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSGO_SIDECAR", executable)
	t.Setenv("COMPILER_FAKE", mode)
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	c := New(Options{Root: "test-root", Version: "test-version", CheckTimeout: 10 * time.Second, RestartBackoff: time.Millisecond})
	t.Cleanup(func() { _ = c.Close() })
	return c
}
func mustExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return executable
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var refusal *Refusal
	if !errors.As(err, &refusal) || refusal.Code != want {
		t.Fatalf("want %s, got %v", want, err)
	}
}
func TestDiscovery(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, sidecarName())
	override := filepath.Join(dir, "override")
	for _, path := range []string{sibling, override} {
		if err := os.WriteFile(path, []byte("fixture"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	exe := filepath.Join(dir, "osgo")
	path, err := discover(override, exe)
	if err != nil || path != override {
		t.Fatalf("env priority: %s %v", path, err)
	}
	path, err = discover(filepath.Join(dir, "missing"), exe)
	if err != nil || path != sibling {
		t.Fatalf("sibling fallback: %s %v", path, err)
	}
	if err := os.Remove(sibling); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	if err := os.WriteFile(sibling, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	missingExe := filepath.Join(dir, "other", "osgo")
	_, err = discover("", missingExe)
	var absent *AbsentError
	if !errors.As(err, &absent) || !reflect.DeepEqual(absent.Paths, []string{filepath.Join(dir, "other", sidecarName())}) {
		t.Fatalf("PATH ignored / tried paths: %v", err)
	}
	_, err = discover(filepath.Join(dir, "absent-env"), missingExe)
	if !errors.As(err, &absent) || len(absent.Paths) != 2 {
		t.Fatalf("both paths recorded: %v", err)
	}
}
func TestHelloAndCheck(t *testing.T) {
	c := fake(t, "answer")
	if c.proc != nil || c.Status().Found {
		t.Fatal("must be lazy")
	}
	result, err := c.Check(context.Background(), Snapshot{})
	if err != nil {
		t.Fatal(err)
	}
	if result.RegistryHash != strings.Repeat("a", 64) || result.ConfigSha != strings.Repeat("b", 64) || result.InputCount != 2 || !reflect.DeepEqual(result.VirtualFiles, []string{"virtual"}) || len(result.Diagnostics) != 1 || result.Diagnostics[0].Col != 12 {
		t.Fatalf("answer: %+v", result)
	}
	status := c.Status()
	if !status.Found || status.Path == "" || status.OSD != "test-osd" || status.Transpiler != "test-pin" || status.Contract != 1 || status.Limits != (Limits{4 * 1024 * 1024, 1}) || !reflect.DeepEqual(status.Capabilities, []string{"check"}) {
		t.Fatalf("hello: %+v", status)
	}
	status.Capabilities[0] = "mutated"
	if c.Status().Capabilities[0] != "check" {
		t.Fatal("status must be copied")
	}
}
func TestRefusals(t *testing.T) {
	for _, want := range []string{"UNSUPPORTED_OP", "SNAPSHOT_MISMATCH", "BUSY", "INTERNAL", "VERSION_MISMATCH"} {
		t.Run(want, func(t *testing.T) {
			c := fake(t, "refuse:"+want)
			_, err := c.Check(context.Background(), Snapshot{})
			code(t, err, want)
			if c.Status().LastError == "" {
				t.Fatal("last error missing")
			}
		})
	}
}
func TestUnsupportedWithoutSend(t *testing.T) {
	c := fake(t, "unsupported")
	marker := filepath.Join(t.TempDir(), "sent")
	t.Setenv("COMPILER_MARKER", marker)
	_, err := c.Check(context.Background(), Snapshot{})
	code(t, err, "UNSUPPORTED_OP")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("check was sent: %v", err)
	}
}
func TestTimeoutRestart(t *testing.T) {
	c := fake(t, "timeout")
	if err := c.Hello(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.options.CheckTimeout = 30 * time.Millisecond
	_, err := c.Check(context.Background(), Snapshot{})
	code(t, err, "TIMEOUT")
	if c.proc != nil {
		t.Fatal("child retained")
	}
	t.Setenv("COMPILER_FAKE", "answer")
	c.options.CheckTimeout = time.Second
	if _, err = c.Check(context.Background(), Snapshot{}); err != nil {
		t.Fatal(err)
	}
	if c.Status().Restarts != 1 || !strings.Contains(c.Status().LastError, "TIMEOUT") {
		t.Fatalf("restart: %+v", c.Status())
	}
}
func TestAdmissionRespectsContext(t *testing.T) {
	c := fake(t, "timeout")
	marker := filepath.Join(t.TempDir(), "sent")
	t.Setenv("COMPILER_MARKER", marker)
	c.options.CheckTimeout = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := c.Check(ctx, Snapshot{})
		done <- err
	}()
	waitFile(t, marker)
	start := time.Now()
	shortCtx, shortCancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	err := c.Hello(shortCtx)
	shortCancel()
	elapsed := time.Since(start)
	code(t, err, "TIMEOUT")
	if elapsed > 500*time.Millisecond {
		t.Fatalf("queued Hello blocked for %s", elapsed)
	}
	cancel()
	if err = <-done; err == nil || !strings.Contains(err.Error(), "TIMEOUT") {
		t.Fatal(err)
	}
}
func TestFastExitResponse(t *testing.T) {
	t.Setenv("OSGO_SIDECAR", mustExecutable(t))
	t.Setenv("COMPILER_FAKE", "answer-exit")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	for iteration := range 200 {
		c := New(Options{Root: "test-root", Version: "test-version", CheckTimeout: 2 * time.Second, RestartBackoff: time.Millisecond})
		if _, err := c.Check(context.Background(), Snapshot{}); err != nil {
			t.Fatalf("iteration %d failed: %v", iteration+1, err)
		}
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
func TestIdleDeathRestart(t *testing.T) {
	c := fake(t, "answer")
	if err := c.Hello(context.Background()); err != nil {
		t.Fatal(err)
	}
	kill := c.proc.kill
	dead := c.proc.dead
	kill()
	select {
	case <-c.proc.done:
	case <-time.After(time.Second):
		t.Fatal("exit was not observed")
	}
	if err := c.Hello(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Status().Restarts != 1 || c.proc == nil {
		t.Fatalf("idle restart: restarts=%d cmd=%v", c.Status().Restarts, c.proc)
	}
	select {
	case <-dead:
	default:
		t.Fatal("old child was not reaped")
	}
}

func TestRestartBackoffDelay(t *testing.T) {
	c := fake(t, "timeout")
	marker := filepath.Join(t.TempDir(), "sent")
	t.Setenv("COMPILER_MARKER", marker)
	c.options.RestartBackoff = 37 * time.Millisecond
	if err := c.Hello(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.Check(ctx, Snapshot{}); done <- err }()
	waitFile(t, marker) // handshake and request reached the fixture before cancellation
	cancel()
	code(t, <-done, "TIMEOUT")
	t.Setenv("COMPILER_FAKE", "answer")
	base := c.retryAt.Add(-37 * time.Millisecond)
	c.now = func() time.Time { return base }
	var delays []time.Duration
	c.after = func(delay time.Duration) <-chan time.Time {
		delays = append(delays, delay)
		return time.After(0)
	}
	if _, err := c.Check(context.Background(), Snapshot{}); err != nil {
		t.Fatal(err)
	}
	if len(delays) != 1 || delays[0] != 37*time.Millisecond {
		t.Fatalf("backoff delays: %v", delays)
	}
}
func TestCrashRestart(t *testing.T) {
	c := fake(t, "crash")
	_, err := c.Check(context.Background(), Snapshot{})
	code(t, err, "INTERNAL")
	if c.proc != nil {
		t.Fatal("child retained")
	}
	t.Setenv("COMPILER_FAKE", "answer")
	if _, err = c.Check(context.Background(), Snapshot{}); err != nil {
		t.Fatal(err)
	}
	if c.Status().Restarts != 1 {
		t.Fatalf("restart count: %+v", c.Status())
	}
}
func TestContractMismatch(t *testing.T) {
	c := fake(t, "mismatch")
	err := c.Hello(context.Background())
	code(t, err, "CONTRACT_MISMATCH")
	if c.proc != nil || c.Status().Contract != 2 {
		t.Fatal("mismatched process retained or contract lost")
	}
}
func TestBadID(t *testing.T) {
	c := fake(t, "bad-id")
	_, err := c.Check(context.Background(), Snapshot{})
	code(t, err, "INTERNAL")
	if c.proc != nil {
		t.Fatal("bad protocol retained")
	}
}
func TestSerialized(t *testing.T) {
	c := fake(t, "answer")
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Check(context.Background(), Snapshot{}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if c.nextID != 8 || c.Status().Restarts != 0 {
		t.Fatal("requests not serialized")
	}
}
func TestTranspilerExpectation(t *testing.T) {
	t.Run("accept-and-report", func(t *testing.T) {
		c := fake(t, "answer")
		if err := c.Hello(context.Background()); err != nil {
			t.Fatal(err)
		}
		if c.Status().Transpiler != "test-pin" {
			t.Fatal("accepted pin was not reported")
		}
	})
	t.Run("mismatch", func(t *testing.T) {
		c := fake(t, "other-pin")
		c.options.ExpectTranspiler = "test-pin"
		err := c.Hello(context.Background())
		code(t, err, "VERSION_MISMATCH")
		if c.proc != nil {
			t.Fatal("mismatched process retained")
		}
	})
}
func TestHelloRequiredFields(t *testing.T) {
	for _, field := range []string{"contract", "osd", "transpiler", "capabilities", "limits"} {
		t.Run(field, func(t *testing.T) {
			c := fake(t, "hello-missing:"+field)
			err := c.Hello(context.Background())
			code(t, err, "HANDSHAKE")
		})
	}
}
func TestSnapshot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	_ = os.WriteFile(outside, []byte("outside"), 0600)
	_ = os.WriteFile(filepath.Join(root, "file"), []byte("abc"), 0600)
	objects := []ObjectFiles{{Type: "CLAS", Name: "ZCL_FIXTURE", Version: "inactive", Files: []string{"file"}}}
	snap, err := BuildSnapshot(context.Background(), root, "generation", objects, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Objects[0].Files[0].SHA256 != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" || snap.Generation != "generation" || snap.Root != root {
		t.Fatalf("snapshot: %+v", snap)
	}
	if err = os.WriteFile(filepath.Join(filepath.Dir(root), "escape"), []byte("sibling"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../escape", outside} {
		objects[0].Files = []string{path}
		if _, err = BuildSnapshot(context.Background(), root, "generation", objects, 1024); err == nil {
			t.Fatalf("accepted escape %s", path)
		}
		var pathErr *SnapshotPathError
		if !errors.As(err, &pathErr) {
			t.Fatalf("lexical refusal for %s is %T, want *SnapshotPathError", path, err)
		}
	}
	objects[0].Files = []string{"link"}
	if _, err = BuildSnapshot(context.Background(), root, "generation", objects, 1024); err == nil {
		t.Fatal("accepted symlink escape")
	}
	var pathErr *SnapshotPathError
	if errors.As(err, &pathErr) {
		t.Fatalf("symlink escape used lexical error: %v", err)
	}
}

func TestSnapshotRefusesFifoPromptly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("FIFO fixture is Unix-specific")
	}
	root := t.TempDir()
	fifo := filepath.Join(root, "fifo")
	makeSnapshotFifo(t, fifo)
	start := time.Now()
	_, err := BuildSnapshot(context.Background(), root, "generation", []ObjectFiles{{Files: []string{"fifo"}}}, 1024)
	if err == nil {
		t.Fatal("accepted FIFO")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("FIFO refusal blocked for %s", elapsed)
	}
}

func TestSnapshotByteLimit(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "large"), []byte("abc"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := BuildSnapshot(context.Background(), root, "generation", []ObjectFiles{{Files: []string{"large"}}}, 2)
	var pathErr *SnapshotPathError
	if !errors.As(err, &pathErr) || pathErr.Reason != "too-large" {
		t.Fatalf("single-file limit: %v", err)
	}
	if err = os.WriteFile(filepath.Join(root, "second"), []byte("c"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "first"), []byte("ab"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = BuildSnapshot(context.Background(), root, "generation", []ObjectFiles{{Files: []string{"first", "second"}}}, 2)
	if !errors.As(err, &pathErr) || pathErr.Reason != "too-large" {
		t.Fatalf("total limit: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = BuildSnapshot(ctx, root, "generation", []ObjectFiles{{Files: []string{"first", "second"}}}, 2)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled snapshot: %v", err)
	}
}

func startDescendant() {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), "COMPILER_FAKE=descendant")
	child.Stdout = os.Stdout
	if child.Start() != nil {
		os.Exit(8)
	}
	for {
		if raw, err := os.ReadFile(os.Getenv("COMPILER_MARKER") + ".pid"); err == nil && len(raw) > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPersistentWorkersClearRequestLabels(t *testing.T) {
	c := fake(t, "answer")
	pprof.Do(context.Background(), pprof.Labels("request", "compiler-first-request"), func(ctx context.Context) {
		if _, err := c.Check(ctx, Snapshot{}); err != nil {
			t.Fatal(err)
		}
	})
	// Startup is asynchronous: wait until both persistent entry points are
	// parked. Inspect live goroutine labels, rather than the request context.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var buf bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&buf, 1); err != nil {
			t.Fatal(err)
		}
		profile := buf.String()
		reader := strings.Contains(profile, "compiler.(*proc).read")
		watcher := strings.Contains(profile, "compiler.startProcess.func")
		if reader && watcher && !strings.Contains(profile, "compiler-first-request") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("workers retain request labels or are absent:\n%s", profile)
		}
		time.Sleep(time.Millisecond)
	}
}
