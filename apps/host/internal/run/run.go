// Package run starts programs the way the helper always does: no shell, an exact environment,
// stdin closed unless given, a new session (so nothing can prompt and nothing has a controlling
// terminal) and, on a timeout, a kill of the whole process group. Output is capped at 64 KB.
package run

import (
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// NoCode is the exit code of a program that could not start, ran too long, or was ended by a signal.
const NoCode = -1

// MaxOutput is how much of a program's stdout and of its stderr is kept.
const MaxOutput = 64 * 1024

// Options say how to run a program.
type Options struct {
	// Env is the program's whole environment. Nothing of the helper's is added.
	Env map[string]string
	// Timeout ends the program (and its process group) when it runs longer. Zero means no limit.
	Timeout time.Duration
	// Input is written to stdin, then stdin is closed. Empty: stdin is closed at once.
	Input string
	// Cwd is where the program runs. Empty: the helper's own folder.
	Cwd string
	// MaxOutput is how much of stdout and of stderr is kept. Zero: MaxOutput (64 KB).
	MaxOutput int
	// Tail keeps the end of the output instead of the beginning, for a failing build whose reason comes last.
	Tail bool
}

// Result is what a run came to. Code is NoCode when the program could not start or timed out.
// Arguments are never put in an error, so a secret in one cannot leak.
type Result struct {
	Code   int
	Stdout string
	Stderr string
	// TimedOut is true when the program ran past Options.Timeout and was killed.
	TimedOut bool
}

// OK is true for a program that ran and exited 0.
func (r Result) OK() bool { return r.Code == 0 }

// Func runs a program to the end. It is the seam tests replace.
type Func func(file string, args []string, options Options) Result

// Exec is the real Func.
func Exec(file string, args []string, options Options) Result {
	var mu sync.Mutex
	limit := options.MaxOutput
	if limit <= 0 {
		limit = MaxOutput
	}
	stdout, stderr := capped{limit: limit, tail: options.Tail}, capped{limit: limit, tail: options.Tail}
	proc := Spawn(SpawnOptions{
		File: file,
		Args: args,
		Env:  options.Env,
		Cwd:  options.Cwd,
		OnStdout: func(b []byte) {
			mu.Lock()
			stdout.add(b)
			mu.Unlock()
		},
		OnStderr: func(b []byte) {
			mu.Lock()
			stderr.add(b)
			mu.Unlock()
		},
		Stdin: true,
	})
	if options.Input != "" {
		// A program that never reads must not hold the helper: the write waits on its own.
		go func() {
			proc.WriteStdin(options.Input)
			proc.CloseStdin()
		}()
	} else {
		proc.CloseStdin()
	}
	code := NoCode
	timedOut := false
	if options.Timeout <= 0 {
		code = proc.Wait()
	} else {
		select {
		case <-proc.Done():
			code = proc.Wait()
		case <-time.After(options.Timeout):
			timedOut = true
			// Its own process group, so what it started goes too: a test run is a tree.
			proc.Kill()
			// A program that escaped its group may hold the pipes open. Give up on it after a moment.
			select {
			case <-proc.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return Result{Code: code, Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: timedOut}
}

type capped struct {
	b     []byte
	limit int
	tail  bool
}

func (c *capped) add(chunk []byte) {
	if c.tail {
		c.b = append(c.b, chunk...)
		if len(c.b) > c.limit {
			c.b = append([]byte(nil), c.b[len(c.b)-c.limit:]...)
		}
		return
	}
	room := c.limit - len(c.b)
	if room <= 0 {
		return
	}
	if len(chunk) > room {
		chunk = chunk[:room]
	}
	c.b = append(c.b, chunk...)
}

func (c *capped) String() string { return strings.ToValidUTF8(string(c.b), "�") }

// SpawnOptions start a program that keeps running while the helper does other things.
type SpawnOptions struct {
	File string
	Args []string
	Env  map[string]string
	Cwd  string
	// Stdin opens a pipe for WriteStdin. Without it stdin is closed.
	Stdin    bool
	OnStdout func([]byte)
	OnStderr func([]byte)
}

// Proc is a running program.
type Proc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	done  chan struct{}
	code  int
	once  sync.Once
}

// Spawn starts the program. A program that cannot start gives a Proc that is already done with NoCode.
func Spawn(o SpawnOptions) *Proc {
	p := &Proc{done: make(chan struct{}), code: NoCode}
	file, ok := Resolve(o.File, o.Env["PATH"])
	if !ok {
		close(p.done)
		return p
	}
	cmd := exec.Command(file, o.Args...)
	cmd.Env = EnvList(o.Env)
	cmd.Dir = o.Cwd
	configure(cmd)
	var readers sync.WaitGroup
	pipe := func(open func() (io.ReadCloser, error), sink func([]byte)) bool {
		r, err := open()
		if err != nil {
			return false
		}
		readers.Add(1)
		go func() {
			defer readers.Done()
			buf := make([]byte, 32*1024)
			for {
				n, err := r.Read(buf)
				if n > 0 && sink != nil {
					sink(append([]byte(nil), buf[:n]...))
				}
				if err != nil {
					return
				}
			}
		}()
		return true
	}
	if o.Stdin {
		w, err := cmd.StdinPipe()
		if err == nil {
			p.stdin = w
		}
	}
	if !pipe(func() (io.ReadCloser, error) { return cmd.StdoutPipe() }, o.OnStdout) ||
		!pipe(func() (io.ReadCloser, error) { return cmd.StderrPipe() }, o.OnStderr) {
		close(p.done)
		return p
	}
	if err := cmd.Start(); err != nil {
		close(p.done)
		return p
	}
	p.cmd = cmd
	go func() {
		readers.Wait()
		err := cmd.Wait()
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			p.code = cmd.ProcessState.ExitCode()
		} else if err == nil {
			p.code = 0
		}
		close(p.done)
	}()
	return p
}

// Done is closed when the program ended and its output was read.
func (p *Proc) Done() <-chan struct{} { return p.done }

// Wait waits for the program and returns its exit code, or NoCode.
func (p *Proc) Wait() int {
	<-p.done
	return p.code
}

// WriteStdin writes text to the program's stdin. Errors are dropped: a program that closed stdin is not a failure.
func (p *Proc) WriteStdin(text string) {
	if p.stdin != nil {
		_, _ = io.WriteString(p.stdin, text)
	}
}

// CloseStdin closes the program's stdin.
func (p *Proc) CloseStdin() {
	if p.stdin != nil {
		p.once.Do(func() { _ = p.stdin.Close() })
	}
}

// Kill ends the program and anything it started, at once.
func (p *Proc) Kill() { p.signal(true) }

// Terminate asks the program and anything it started to end.
func (p *Proc) Terminate() { p.signal(false) }

func (p *Proc) signal(hard bool) {
	if p.cmd != nil && p.cmd.Process != nil {
		killGroup(p.cmd, hard)
	}
}

// EnvList is an environment map as `NAME=value` lines, sorted. A nil map gives an empty (not inherited) environment.
func EnvList(env map[string]string) []string {
	list := make([]string, 0, len(env))
	for name, value := range env {
		list = append(list, name+"="+value)
	}
	sort.Strings(list)
	return list
}

// Resolve finds the program the way the job's own PATH would: a name with a separator is taken as it is,
// else the first executable of that name on pathEnv (or the system's default path when it is empty).
func Resolve(file, pathEnv string) (string, bool) {
	if file == "" {
		return "", false
	}
	if strings.ContainsRune(file, os.PathSeparator) {
		return file, true
	}
	if pathEnv == "" {
		pathEnv = "/usr/bin:/bin"
	}
	for _, dir := range strings.Split(pathEnv, ":") {
		if dir == "" {
			dir = "."
		}
		candidate := dir + string(os.PathSeparator) + file
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
			return candidate, true
		}
	}
	return "", false
}
