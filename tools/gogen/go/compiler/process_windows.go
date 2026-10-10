package compiler

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime/pprof"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func sidecarName() string                  { return "osd.exe" }
func executableFile(info os.FileInfo) bool { return true }

// Start suspended so no descendant can escape before job assignment. The job
// handle belongs to the client, surviving the direct child's exit.
func startProcess(cmd *exec.Cmd) (processLifecycle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return processLifecycle{}, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return processLifecycle{}, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err = cmd.Start(); err != nil {
		windows.CloseHandle(job)
		return processLifecycle{}, err
	}
	var once sync.Once
	kill := func() { once.Do(func() { _ = windows.TerminateJobObject(job, 1); _ = windows.CloseHandle(job) }) }
	fail := func(err error) (processLifecycle, error) {
		kill()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return processLifecycle{}, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fail(err)
	}
	err = windows.AssignProcessToJobObject(job, process)
	windows.CloseHandle(process)
	if err != nil {
		return fail(err)
	}
	if err = resumeProcess(uint32(cmd.Process.Pid)); err != nil {
		return fail(err)
	}
	var waitOnce sync.Once
	waitErr := error(nil)
	wait := func() error {
		waitOnce.Do(func() { waitErr = cmd.Wait() })
		return waitErr
	}
	exited := make(chan struct{})
	go func() {
		pprof.SetGoroutineLabels(context.Background())
		defer close(exited)
		_ = wait()
	}()
	return processLifecycle{kill: kill, wait: wait, exited: exited}, nil
}

func resumeProcess(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		return err
	}
	return fmt.Errorf("cannot find suspended sidecar thread: %w", err)
}
