// Package download fetches a small file from the internet for tools the helper installs itself.
// The caller checks its hash.
package download

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Func fetches url. Errors are plain sentences.
type Func func(url string) ([]byte, error)

const (
	timeout = 60 * time.Second
	// MaxBytes is far above anything the helper fetches (terminal-notifier is about 400 KB).
	MaxBytes = 20_000_000
)

// Bytes fetches url over https, following redirects. It fails in plain words when the file did not arrive whole.
func Bytes(url string) ([]byte, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, errors.New("Only https downloads are allowed.")
	}
	client := &http.Client{Timeout: timeout}
	res, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("The download failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("The download failed with HTTP %d.", res.StatusCode)
	}
	if res.ContentLength > MaxBytes {
		return nil, errors.New("The download is larger than expected.")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("The download failed: %w", err)
	}
	if len(body) > MaxBytes {
		return nil, errors.New("The download is larger than expected.")
	}
	return body, nil
}
