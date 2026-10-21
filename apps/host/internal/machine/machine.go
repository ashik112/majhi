// Package machine reads this computer's load, memory and free disk. Read-only, a second or so.
package machine

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const toolTimeout = 8 * time.Second

// ParseVMStat is the bytes the system can hand back at once, from `vm_stat`: free, inactive,
// speculative and purgeable pages.
func ParseVMStat(out string) (float64, bool) {
	size := 0.0
	if _, rest, ok := strings.Cut(out, "page size of "); ok {
		digits := leadingDigits(rest)
		size, _ = strconv.ParseFloat(digits, 64)
		if digits == "" || !strings.HasPrefix(rest[len(digits):], " bytes") {
			size = 0
		}
	}
	if size == 0 {
		return 0, false
	}
	pages, seen := 0.0, 0
	for _, name := range []string{"free", "inactive", "speculative", "purgeable"} {
		for _, line := range strings.Split(out, "\n") {
			rest, ok := strings.CutPrefix(line, "Pages "+name+":")
			if !ok {
				continue
			}
			digits := leadingDigits(strings.TrimLeft(rest, " \t"))
			if digits == "" || len(rest) == len(strings.TrimLeft(rest, " \t")) {
				continue
			}
			n, _ := strconv.ParseFloat(digits, 64)
			pages += n
			seen++
			break
		}
	}
	if seen == 0 {
		return 0, false
	}
	return pages * size, true
}

func leadingDigits(s string) string {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	return s[:end]
}

// ParseTopIdle is the idle percent from the `CPU usage:` line of `top -l 1`.
func ParseTopIdle(out string) (float64, bool) {
	_, rest, ok := strings.Cut(out, "CPU usage:")
	if !ok {
		return 0, false
	}
	line, _, _ := strings.Cut(rest, "\n")
	at := strings.Index(line, "% idle")
	if at <= 0 {
		return 0, false
	}
	start := at
	for start > 0 && (line[start-1] == '.' || (line[start-1] >= '0' && line[start-1] <= '9')) {
		start--
	}
	v, err := strconv.ParseFloat(line[start:at], 64)
	return v, err == nil && start < at
}

// ParsePressure reads `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
func ParsePressure(out string) string {
	switch strings.TrimSpace(out) {
	case "1":
		return "normal"
	case "2":
		return "warn"
	case "4":
		return "critical"
	}
	return ""
}

// ParseDf reads the size and the free bytes of the volume from `df -Pk <path>`.
func ParseDf(out string) (total, free float64, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		for i := 3; i+1 < len(fields); i++ {
			if !strings.HasSuffix(fields[i], "%") || !strings.HasPrefix(fields[i+1], "/") {
				continue
			}
			t, errT := strconv.ParseFloat(fields[i-3], 64)
			_, errU := strconv.ParseFloat(fields[i-2], 64)
			f, errF := strconv.ParseFloat(fields[i-1], 64)
			if errT == nil && errU == nil && errF == nil {
				return t * 1024, f * 1024, true
			}
		}
	}
	return 0, 0, false
}

// ParseMeminfo is MemAvailable and MemTotal in bytes from /proc/meminfo.
func ParseMeminfo(out string) (total, available float64, ok bool) {
	kb := func(key string) (float64, bool) {
		for _, line := range strings.Split(out, "\n") {
			rest, found := strings.CutPrefix(line, key+":")
			if !found {
				continue
			}
			fields := strings.Fields(rest)
			if len(fields) == 2 && fields[1] == "kB" {
				n, err := strconv.ParseFloat(fields[0], 64)
				return n * 1024, err == nil
			}
		}
		return 0, false
	}
	t, okT := kb("MemTotal")
	a, okA := kb("MemAvailable")
	return t, a, okT && okA
}

// Deps are what a reading needs.
type Deps struct {
	OS  string
	Run run.Func
	// Home is where free disk is measured: the owner's home.
	Home string
	Env  map[string]string
}

// Read reads this computer's load, memory and free disk.
func Read(d Deps) (protocol.MachineHost, error) {
	tool := func(file string, args ...string) string {
		r := d.Run(file, args, run.Options{Env: d.Env, Cwd: d.Home, Timeout: toolTimeout, MaxOutput: 1 << 20})
		if r.Code != 0 {
			return ""
		}
		return r.Stdout
	}
	host := protocol.MachineHost{Cores: max(1, runtime.NumCPU())}
	host.Load1, host.Load5, host.Load15 = loadAverage(d.OS, tool)
	if total, free, ok := ParseDf(tool("df", "-Pk", d.Home)); ok {
		host.DiskTotalBytes, host.DiskFreeBytes = &total, &free
	}
	memTotal := 0.0
	var available *float64
	if d.OS == protocol.OSMacOS {
		if n, err := strconv.ParseFloat(strings.TrimSpace(tool("sysctl", "-n", "hw.memsize")), 64); err == nil {
			memTotal = n
		}
		vm, level, top := tool("vm_stat"), tool("sysctl", "-n", "kern.memorystatus_vm_pressure_level"), tool("top", "-l", "1", "-n", "0", "-s", "0")
		if v, ok := ParseVMStat(vm); ok {
			available = &v
		}
		host.Pressure = ParsePressure(level)
		if idle, ok := ParseTopIdle(top); ok {
			idle = min(100, idle)
			host.IdleCPUPct = &idle
		}
	} else {
		data, _ := os.ReadFile("/proc/meminfo")
		if total, avail, ok := ParseMeminfo(string(data)); ok {
			memTotal = total
			available = &avail
		}
	}
	host.MemTotalBytes = memTotal
	if available != nil {
		v := min(*available, memTotal)
		host.MemAvailableBytes = &v
	}
	return host, nil
}

func loadAverage(os string, tool func(string, ...string) string) (l1, l5, l15 float64) {
	var fields []string
	if os == protocol.OSMacOS {
		fields = strings.Fields(strings.Trim(strings.TrimSpace(tool("sysctl", "-n", "vm.loadavg")), "{}"))
	} else if data, err := readFile("/proc/loadavg"); err == nil {
		fields = strings.Fields(data)
	}
	if len(fields) < 3 {
		return 0, 0, 0
	}
	l1, _ = strconv.ParseFloat(fields[0], 64)
	l5, _ = strconv.ParseFloat(fields[1], 64)
	l15, _ = strconv.ParseFloat(fields[2], 64)
	return l1, l5, l15
}

func readFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	return string(data), err
}
