package compiler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime/pprof"
	"sync/atomic"
)

// proc owns one child. Closing done publishes readErr; dead means Wait returned.
type proc struct {
	kill     func()
	wait     func() error
	stdin    io.WriteCloser
	stdout   *os.File
	answers  chan json.RawMessage
	done     chan struct{}
	exited   <-chan struct{}
	dead     chan struct{}
	readErr  error
	maxLine  atomic.Int64
	pidValue int
}

func newProc(cmd *exec.Cmd, lifecycle processLifecycle, stdin io.WriteCloser, stdout *os.File) *proc {
	p := &proc{
		kill: lifecycle.kill, wait: lifecycle.wait, exited: lifecycle.exited,
		stdin: stdin, stdout: stdout, answers: make(chan json.RawMessage, 1),
		done: make(chan struct{}), dead: make(chan struct{}), pidValue: cmd.Process.Pid,
	}
	p.maxLine.Store(1024 * 1024) // bounded hello before the response budget applies
	go p.read()
	return p
}

func (p *proc) pid() int { return p.pidValue }

type processLifecycle struct {
	kill   func()
	wait   func() error
	exited <-chan struct{}
}

func (p *proc) read() {
	pprof.SetGoroutineLabels(context.Background())
	defer close(p.done)
	defer p.stdout.Close()
	reader := bufio.NewReader(p.stdout)
	for {
		var line []byte
		for {
			fragment, err := reader.ReadSlice('\n')
			if int64(len(line))+int64(len(fragment)) > p.maxLine.Load() {
				p.readErr = errors.New("sidecar response exceeds line limit")
				return
			}
			line = append(line, fragment...)
			if err == bufio.ErrBufferFull {
				continue
			}
			if err != nil {
				p.readErr = err
				return
			}
			break
		}
		if !json.Valid(line) {
			p.readErr = errors.New("malformed sidecar response")
			return
		}
		select {
		case p.answers <- json.RawMessage(line):
		default:
			p.readErr = errors.New("unsolicited sidecar response")
			return
		}
	}
}

func (p *proc) finalAnswer() (json.RawMessage, error) {
	select {
	case raw := <-p.answers:
		return raw, nil
	default:
		return nil, p.readErr
	}
}

func (p *proc) answer(ctx context.Context) (json.RawMessage, error) {
	// Give completed reads a deterministic path, including answers buffered at EOF.
	select {
	case <-p.done:
		return p.finalAnswer()
	default:
	}
	select {
	case raw := <-p.answers:
		return raw, nil
	case <-p.done:
		return p.finalAnswer()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
