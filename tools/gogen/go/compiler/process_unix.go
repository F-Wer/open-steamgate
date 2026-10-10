//go:build !windows

package compiler

import (
	"context"
	"os"
	"os/exec"
	"runtime/pprof"
	"sync"
	"syscall"
)

func sidecarName() string                  { return "osd" }
func executableFile(info os.FileInfo) bool { return info.Mode()&0111 != 0 }
func startProcess(cmd *exec.Cmd) (processLifecycle, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return processLifecycle{}, err
	}
	exited := make(chan struct{})
	var once sync.Once
	markExited := func() { once.Do(func() { close(exited) }) }
	go func() {
		pprof.SetGoroutineLabels(context.Background())
		// Only an observed exit closes exited: a failed wait must not make a
		// healthy sidecar look dead (the reader still sees a real death as EOF).
		// ECHILD is not proof of exit (a debugger can reparent a live child);
		// when our own cleanup reaped it, wait below has closed exited already.
		if waitForExitWithoutReap(cmd.Process.Pid) == nil {
			markExited()
		}
	}()
	return processLifecycle{
		kill: func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) },
		wait: func() error {
			err := cmd.Wait()
			markExited()
			return err
		},
		exited: exited,
	}, nil
}
