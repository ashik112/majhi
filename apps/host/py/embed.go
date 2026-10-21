// Package py carries layad.py, the Python service of Laya, inside the helper's binary.
package py

import _ "embed" // layad.py

// Layad is the source of the Laya service. The helper writes it next to Laya's venv.
//
//go:embed layad.py
var Layad string
