// Package client is the helper's link to majhi's server: it long-polls for jobs and posts replies
// and progress. The helper opens no port.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
)

const (
	// BackoffStart is the wait after the first failure.
	BackoffStart = 250 * time.Millisecond
	// BackoffMax is the longest wait between tries.
	BackoffMax = 5 * time.Second
	// pollRequestTimeout drops a poll the server never answers, then retries.
	pollRequestTimeout = time.Duration(protocol.PollTimeoutMs)*time.Millisecond + 10*time.Second
	replyTimeout       = 10 * time.Second
	maxBody            = 4 << 20
)

// Backoff waits 250 ms after the first failure, doubling up to 5 s. Reset after a success.
type Backoff struct{ delay time.Duration }

// Next is how long to wait now.
func (b *Backoff) Next() time.Duration {
	if b.delay == 0 {
		b.delay = BackoffStart
	}
	current := b.delay
	b.delay = min(b.delay*2, BackoffMax)
	return current
}

// Reset starts the waits over.
func (b *Backoff) Reset() { b.delay = BackoffStart }

// Link is how the helper reaches the server.
type Link struct {
	// URL is majhi's server, like http://127.0.0.1:7070.
	URL string
	// Token is read before each request, so a replaced token file is picked up.
	Token func() (string, error)
	// Info is read before each poll, so the state in it stays current.
	Info func() protocol.HostInfo
	Log  hostlog.Logger
	HTTP *http.Client
	// Sleep waits between tries. Tests replace it.
	Sleep func(ctx context.Context, d time.Duration)
}

func (l *Link) client() *http.Client {
	if l.HTTP != nil {
		return l.HTTP
	}
	return http.DefaultClient
}

func (l *Link) sleep(ctx context.Context, d time.Duration) {
	if l.Sleep != nil {
		l.Sleep(ctx, d)
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

func (l *Link) request(ctx context.Context, path string, body io.Reader) (*http.Request, error) {
	token, err := l.Token()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.URL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return req, nil
}

// PollLoop polls the server for jobs until ctx ends. It backs off while the server is down or
// refuses the token, and logs only when the state changes, so a stopped majhi does not fill the log.
// onJob is called for every job without waiting, so a slow job never holds up the next poll.
func (l *Link) PollLoop(ctx context.Context, onJob func(protocol.Job)) {
	var backoff Backoff
	backoff.Reset()
	state := ""
	report := func(next string) {
		if next != state {
			l.Log(next)
		}
		state = next
	}
	for ctx.Err() == nil {
		status, body, err := l.pollOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			report(fmt.Sprintf("cannot reach majhi at %s (%s), retrying", l.URL, describe(err)))
			l.sleep(ctx, backoff.Next())
			continue
		}
		if status == http.StatusNoContent || status == http.StatusOK {
			report("connected to majhi at " + l.URL)
			backoff.Reset()
			if status == http.StatusOK {
				l.handleJobBody(body, onJob)
			}
			continue
		}
		if status == http.StatusUnauthorized {
			report(fmt.Sprintf("majhi at %s refused the token in %s; check that MAJHI_HOME matches the server's", l.URL, protocol.TokenFile))
		} else {
			report(fmt.Sprintf("majhi at %s answered %d, retrying", l.URL, status))
		}
		l.sleep(ctx, backoff.Next())
	}
}

func (l *Link) pollOnce(ctx context.Context) (int, []byte, error) {
	header, err := protocol.EncodeInfo(l.Info())
	if err != nil {
		return 0, nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, pollRequestTimeout)
	defer cancel()
	req, err := l.request(reqCtx, "/api/host/poll", nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set(protocol.HostInfoHeader, header)
	res, err := l.client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return 0, nil, err
	}
	return res.StatusCode, body, nil
}

// handleJobBody runs a job, or answers one that does not parse with the reason, when it has an id.
func (l *Link) handleJobBody(body []byte, onJob func(protocol.Job)) {
	job, perr := protocol.ParseJob(body)
	if perr == nil {
		onJob(job)
		return
	}
	l.Log(fmt.Sprintf("ignored a job this helper does not understand (method %s)", perr.Method))
	if perr.ID == "" {
		return
	}
	message := fmt.Sprintf("This host helper cannot run %q. Run `make up` to update it.", perr.Method)
	go func() { _ = l.SendReply(context.Background(), protocol.ErrReply(perr.ID, message)) }()
}

// SendReply posts the reply to a job. It fails when the server did not take it.
func (l *Link) SendReply(ctx context.Context, reply protocol.Reply) error {
	data, err := json.Marshal(reply)
	if err != nil {
		l.Log(fmt.Sprintf("reply to job %s failed: %v", reply.ID, err))
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, replyTimeout)
	defer cancel()
	fail := func(err error) error {
		l.Log(fmt.Sprintf("reply to job %s failed: %s", reply.ID, describe(err)))
		return err
	}
	req, err := l.request(reqCtx, "/api/host/reply", bytes.NewReader(data))
	if err != nil {
		return fail(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := l.client().Do(req)
	if err != nil {
		return fail(err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxBody))
	if res.StatusCode != http.StatusNoContent {
		return fail(fmt.Errorf("majhi answered %d", res.StatusCode))
	}
	return nil
}

// SendProgress posts progress of a running job. It never fails: progress that does not arrive is skipped.
func (l *Link) SendProgress(ctx context.Context, id string, progress protocol.Progress) {
	data, err := progress.MarshalWith(id)
	if err != nil {
		return
	}
	reqCtx, cancel := context.WithTimeout(ctx, replyTimeout)
	defer cancel()
	req, err := l.request(reqCtx, "/api/host/progress", bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := l.client().Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxBody))
}

// describe names why a request failed, without the URL Go puts in its error.
func describe(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return err.Error()
}
