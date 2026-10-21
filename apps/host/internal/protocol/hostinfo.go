package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

// EncodeInfo is HostInfo as JSON for a header: non-ASCII characters, like an accented key path,
// become unicode escapes, which is what the server reads back. The JSON is not HTML-escaped.
func EncodeInfo(info HostInfo) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(info); err != nil {
		return "", fmt.Errorf("encode the host info: %w", err)
	}
	text := strings.TrimSuffix(buf.String(), "\n")
	var out strings.Builder
	for _, r := range text {
		if r < 0x80 {
			out.WriteRune(r)
			continue
		}
		if r > 0xFFFF {
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(&out, `\u%04x\u%04x`, hi, lo)
			continue
		}
		fmt.Fprintf(&out, `\u%04x`, r)
	}
	return out.String(), nil
}
