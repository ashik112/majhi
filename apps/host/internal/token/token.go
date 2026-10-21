// Package token keeps the helper's token: the secret the server checks on every poll.
package token

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"majhi/host/internal/protocol"
)

// Ensure returns the token in <majhiHome>/host.token, creating the folder and the token (32 random
// bytes as hex, readable by the owner only) when missing.
func Ensure(majhiHome string) (string, error) {
	if err := os.MkdirAll(majhiHome, 0o755); err != nil {
		return "", fmt.Errorf("make %s: %w", majhiHome, err)
	}
	file := filepath.Join(majhiHome, protocol.TokenFile)
	existing, found, err := read(file)
	if err != nil {
		return "", err
	}
	if found && existing != "" {
		return existing, nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("make a token: %w", err)
	}
	token := hex.EncodeToString(raw)
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if found {
		// An empty file left behind is filled in.
		flags = os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(file, flags, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			// `O_EXCL` never replaces a token another process wrote a moment ago.
			if other, ok, readErr := read(file); readErr == nil && ok && other != "" {
				return other, nil
			}
		}
		return "", fmt.Errorf("write %s: %w", file, err)
	}
	if _, err := f.WriteString(token + "\n"); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("write %s: %w", file, err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("write %s: %w", file, err)
	}
	// The mode only applies when the file is created. An empty file keeps its old mode otherwise.
	if err := os.Chmod(file, 0o600); err != nil {
		return "", fmt.Errorf("protect %s: %w", file, err)
	}
	return token, nil
}

func read(file string) (string, bool, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read %s: %w", file, err)
	}
	return strings.TrimSpace(string(data)), true, nil
}
