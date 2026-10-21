package platform

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	"majhi/host/internal/hostlog"
)

// The SSH agent socket majhi's server container uses on Linux and WSL2 (decision 2). The helper
// listens on `~/.majhi/run/ssh-agent.sock` and pipes each connection to the agent it loads keys
// into, so the container's path stays the same when that agent restarts, changes or appears after
// login. Failures go to the log. What passes through, requests and signatures, never does.

// forwarder is one listener.
type forwarder struct {
	path string
	// upstream is the agent to forward to, or "" when there is none. With failed, the socket that just
	// refused a connection, it is looked up again instead of answered from what was found last.
	upstream func(failed string) string
	log      hostlog.Logger

	mu       sync.Mutex
	open     map[net.Conn]bool
	stopped  bool
	listener net.Listener
	noted    string
}

func connectUnix(path string) net.Conn {
	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil
	}
	return conn
}

// reachable is true when something listens on the socket at path. A dead socket file or any other file is false.
func reachable(path string) bool {
	conn := connectUnix(path)
	if conn == nil {
		return false
	}
	_ = conn.Close()
	return true
}

// serveAgent starts listening and returns a function that stops. It never fails: failures are logged.
func serveAgent(path string, upstream func(failed string) string, log hostlog.Logger) func() {
	f := &forwarder{path: path, upstream: upstream, log: log, open: map[net.Conn]bool{}}
	go f.start()
	return f.stop
}

func (f *forwarder) note(message string) {
	f.mu.Lock()
	same := f.noted == message
	f.noted = message
	f.mu.Unlock()
	if !same {
		f.log("ssh-agent forwarder: " + message)
	}
}

func (f *forwarder) start() {
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.log(fmt.Sprintf("ssh-agent forwarder: cannot listen on %s: %v", f.path, err))
		return
	}
	// Its folder is made 0700, which keeps everyone else out from the start.
	if err := os.Chmod(dir, 0o700); err != nil {
		f.log(fmt.Sprintf("ssh-agent forwarder: cannot listen on %s: %v", f.path, err))
		return
	}
	if info, err := os.Lstat(f.path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			f.log(fmt.Sprintf("ssh-agent forwarder: %s is not a socket, so it was left alone and the forwarder is off", f.path))
			return
		}
		if reachable(f.path) {
			f.log(fmt.Sprintf("ssh-agent forwarder: another helper is serving %s, so this one is off", f.path))
			return
		}
		// Left by a helper that was killed. Nothing listens on it.
		if err := os.Remove(f.path); err != nil {
			f.log(fmt.Sprintf("ssh-agent forwarder: cannot listen on %s: %v", f.path, err))
			return
		}
	}
	listener, err := net.Listen("unix", f.path)
	if err != nil {
		f.log(fmt.Sprintf("ssh-agent forwarder: cannot listen on %s: %v", f.path, err))
		return
	}
	if err := os.Chmod(f.path, 0o600); err != nil {
		f.log(fmt.Sprintf("ssh-agent forwarder: cannot listen on %s: %v", f.path, err))
		_ = listener.Close()
		return
	}
	f.mu.Lock()
	if f.stopped {
		f.mu.Unlock()
		_ = listener.Close()
		return
	}
	f.listener = listener
	f.mu.Unlock()
	f.log("ssh-agent forwarder: listening on " + f.path)
	for {
		client, err := listener.Accept()
		if err != nil {
			f.mu.Lock()
			stopped := f.stopped
			f.mu.Unlock()
			if !stopped {
				f.log(fmt.Sprintf("ssh-agent forwarder: %v", err))
			}
			return
		}
		go f.handle(client)
	}
}

// reach is a connection to the agent found last, else to one looked up again.
func (f *forwarder) reach() net.Conn {
	target := f.upstream("")
	var agent net.Conn
	if target != "" {
		agent = connectUnix(target)
	}
	if agent == nil && target != "" {
		target = f.upstream(target)
		if target != "" {
			agent = connectUnix(target)
		}
	}
	switch {
	case target == "":
		f.note("no agent to forward to")
	case agent == nil:
		f.note("cannot reach the agent at " + target)
	default:
		f.note("forwarding to " + target)
	}
	return agent
}

func (f *forwarder) track(c net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopped {
		return false
	}
	f.open[c] = true
	return true
}

func (f *forwarder) untrack(c net.Conn) {
	f.mu.Lock()
	delete(f.open, c)
	f.mu.Unlock()
}

func (f *forwarder) handle(client net.Conn) {
	if !f.track(client) {
		_ = client.Close()
		return
	}
	defer func() { f.untrack(client); _ = client.Close() }()
	agent := f.reach()
	if agent == nil {
		return
	}
	if !f.track(agent) {
		_ = agent.Close()
		return
	}
	defer func() { f.untrack(agent); _ = agent.Close() }()
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		// What one side sent is delivered, then the other side gets the end.
		if half, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = half.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(agent, client)
	go pipe(client, agent)
	<-done
	<-done
}

func (f *forwarder) stop() {
	f.mu.Lock()
	f.stopped = true
	conns := make([]net.Conn, 0, len(f.open))
	for c := range f.open {
		conns = append(conns, c)
	}
	listener := f.listener
	f.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
}
