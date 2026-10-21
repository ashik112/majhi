// Package download fetches a small file from the internet for tools the helper installs itself.
// The caller checks its hash. Every address it takes is https, and so is every redirect it follows.
package download

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Func fetches url. Errors are plain sentences.
type Func func(url string) ([]byte, error)

const (
	timeout = 60 * time.Second
	// MaxBytes is far above anything the helper fetches (terminal-notifier is about 400 KB).
	MaxBytes = 20_000_000
	maxHops  = 5
)

// isLoopback is true for the names a test server answers on.
func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CheckURL accepts an https address. An http one is accepted only for this computer itself
// (127.0.0.1, localhost, [::1]), where tests serve releases. It decides by parsing the address.
func CheckURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return errors.New("That is not a web address.")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopback(u.Hostname()) {
			return nil
		}
	}
	return errors.New("Only https addresses are allowed.")
}

// Client is an HTTP client for downloads and release reads. It follows a redirect only to https.
func Client(limit time.Duration) *http.Client {
	return &http.Client{
		Timeout: limit,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxHops {
				return errors.New("Too many redirects.")
			}
			if req.URL.Scheme != "https" {
				return errors.New("A redirect to a page that is not https was refused.")
			}
			return nil
		},
	}
}

// Bytes fetches url over https, following redirects that stay on https. It fails in plain words when
// the file did not arrive whole.
func Bytes(raw string) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return nil, errors.New("Only https downloads are allowed.")
	}
	res, err := Client(timeout).Get(raw)
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
