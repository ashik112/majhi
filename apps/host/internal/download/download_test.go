package download

import "testing"

// Only https downloads are allowed: a tool the helper installs never comes over a plain connection.
func TestOnlyHTTPS(t *testing.T) {
	for _, url := range []string{"http://example.test/a.zip", "ftp://example.test/a", "file:///etc/passwd", "//example.test/a", ""} {
		if _, err := Bytes(url); err == nil || err.Error() != "Only https downloads are allowed." {
			t.Fatalf("%q: %v", url, err)
		}
	}
}
