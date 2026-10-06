#!/opt/graphify/bin/python
"""Reads one repo's clean source export for the wiki's facts (docs/design/wiki.md, step 1). No model, no network.

Usage:
  wiki_facts.py <export folder> <cache folder>           writes <cache folder>/reader.json
  wiki_facts.py <export folder> <cache folder> --graph   updates <cache folder>/graph with graphify

Runs in a runner container with no network, the export mounted read-only and only the cache folder writable.
`reader.json` holds what the server turns into facts:

  routes     HTTP routes and WebSocket paths, from OWASP Noir (method, path, file, line)
  entries    queue consumers, timers, commands and sockets, from majhi's own entry pass (`map_inside.py`), plus
             Celery beat schedules and `cron:` fields
  calls      HTTP calls to an address written in a file (`wiki_calls.py`): scheme, host, port, file, line
  files      how many source files the entry pass read

Only names, paths and line numbers leave this script. A value of a setting, a password or a query string never does.
Each tool that fails leaves its list empty and its message in `errors`, so one broken tool does not lose the rest.

The graph pass keeps <cache folder>/graph up to date with graphify, rebuilding only the files whose content changed
since the last pass. It is separate because the first run takes about a minute, and the facts do not wait for it.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import map_inside  # noqa: E402
import wiki_calls  # noqa: E402
from tree_sitter import Parser  # noqa: E402

READER_VERSION = 1
MAX_FILES = 6000
MAX_BYTES = 512 * 1024
MAX_ROUTES = 20000
MAX_ENTRIES = 20000
MAX_CALLS = 2000
MAX_GRAPH_FILES = 30000
MAX_GRAPH_BYTES = 2 * 1024 * 1024
NOIR_TIMEOUT = 180
SKIPPED_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next",
    ".nuxt", ".turbo", ".cache", "coverage", ".idea", ".vscode", "site-packages",
}
TEST_MARKS = (".test.", ".spec.", "/__tests__/", "/tests/", "/test/", "/e2e/", "conftest.py")
SOCKET_PROTOCOLS = {"ws", "wss"}


def source_files(src):
    """Source files the grammars read: relative paths, `/` separated, no dependency, build or hidden folder."""
    out = []
    for root, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not d.startswith("."))
        for name in sorted(names):
            if Path(name).suffix.lower() not in wiki_calls.LANGS:
                continue
            rel = os.path.relpath(os.path.join(root, name), src).replace(os.sep, "/")
            if len(out) >= MAX_FILES:
                return out
            out.append(rel)
    return out


def is_test(rel):
    return any(mark in "/" + rel for mark in TEST_MARKS) or os.path.basename(rel).startswith("test_")


def inside(src, rel):
    """The real file of `rel` when it is a regular file inside the export, else None."""
    path = src / rel
    if path.is_symlink() or not path.is_file():
        return None
    try:
        path.resolve().relative_to(src)
    except ValueError:
        return None
    return path


# ---- Noir: HTTP routes ---------------------------------------------------------------------------


def relative_to(src, path):
    """`path` relative to the export, or None when it is outside it."""
    try:
        return Path(path).resolve().relative_to(src).as_posix()
    except (ValueError, OSError):
        return None


def noir_routes(src):
    noir = os.environ.get("MAJHI_NOIR_BIN", "/usr/local/bin/noir")
    done = subprocess.run(
        [noir, "scan", str(src), "-f", "json", "--no-log", "--no-color", "--no-spinner"],
        env={**os.environ, "HOME": "/tmp", "NO_COLOR": "1"},
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=NOIR_TIMEOUT,
    )
    if done.returncode != 0:
        raise RuntimeError(f"noir exited {done.returncode}: {(done.stderr or done.stdout)[-300:]}")
    rows = json.loads(done.stdout).get("endpoints", [])
    out = []
    for row in rows:
        method, url = row.get("method"), row.get("url")
        details = row.get("details") or {}
        if not isinstance(url, str) or not isinstance(method, str):
            continue
        techs = details.get("technologies") or ([details["technology"]] if details.get("technology") else [])
        for site in details.get("code_paths") or []:
            rel = relative_to(src, site.get("path", ""))
            line = site.get("line")
            if rel is None or not isinstance(line, int) or line < 1:
                continue
            out.append({
                "method": method.upper(), "path": url, "file": rel, "line": line,
                "protocol": row.get("protocol") or "http", "techs": [t for t in techs if isinstance(t, str)],
            })
            break
        if len(out) >= MAX_ROUTES:
            break
    return out


# ---- Entry pass: queues, timers, commands, sockets -------------------------------------------------

ENTRY_TYPES = {"QUEUE": "queue", "SCHEDULE": "timer", "COMMAND": "command", "SOCKET": "socket"}
LABEL_PREFIXES = ("task ", "consumer ")


def identifier_like(name):
    return isinstance(name, str) and name != "" and all(c.isalnum() or c in "_.$" for c in name)


def entry_of(raw, rel):
    """One entry of `map_inside` as a plain record, or None for kinds the wiki does not list."""
    kind = ENTRY_TYPES.get(raw.get("kind"))
    label = raw.get("label")
    if kind is None or not isinstance(label, str) or not isinstance(raw.get("line"), int):
        return None
    handler = raw.get("fn") if identifier_like(raw.get("fn")) else None
    out = {"type": kind, "file": rel, "line": raw["line"], "handler": handler}
    for prefix in LABEL_PREFIXES:
        if label.startswith(prefix):
            label = label[len(prefix):]
    if kind == "timer":
        out["schedule"] = label
    elif kind == "socket":
        out["name"] = label[3:] if label.startswith("WS ") else label
    else:
        out["name"] = label
    return out


# ---- Celery beat schedules and `cron:` fields -------------------------------------------------------


def node_text(node):
    return " ".join(wiki_calls.text(node).split())[:160]


def py_string_value(node):
    return map_inside.py_str(node) if node is not None and node.type == "string" else None


def beat_pairs(dictionary):
    """(job name, task name or None, schedule text, line) of each job of a beat schedule dictionary."""
    out = []
    for pair in dictionary.named_children:
        if pair.type != "pair":
            continue
        key, value = pair.child_by_field_name("key"), pair.child_by_field_name("value")
        name = py_string_value(key)
        if name is None or value is None or value.type != "dictionary":
            continue
        task, schedule = None, None
        for item in value.named_children:
            if item.type != "pair":
                continue
            k, v = py_string_value(item.child_by_field_name("key")), item.child_by_field_name("value")
            if k == "task":
                task = py_string_value(v)
            elif k == "schedule" and v is not None:
                schedule = node_text(v)
        if schedule is not None:
            out.append((name, task, schedule, pair.start_point[0] + 1))
    return out


def py_schedules(root, rel):
    out = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type == "assignment":
            left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
            if left is not None and right is not None and right.type == "dictionary":
                name = wiki_calls.text(left).split(".")[-1]
                if name in ("beat_schedule", "CELERY_BEAT_SCHEDULE"):
                    for job, task, schedule, line in beat_pairs(right):
                        out.append({"type": "timer", "file": rel, "line": line, "schedule": schedule, "handler": task, "name": job})
        elif node.type == "keyword_argument":
            name, value = node.child_by_field_name("name"), node.child_by_field_name("value")
            if name is not None and value is not None and value.type == "dictionary" and wiki_calls.text(name) == "beat_schedule":
                for job, task, schedule, line in beat_pairs(value):
                    out.append({"type": "timer", "file": rel, "line": line, "schedule": schedule, "handler": task, "name": job})
        elif node.type == "call":
            fn, args = node.child_by_field_name("function"), node.child_by_field_name("arguments")
            if fn is not None and args is not None and map_inside.py_last(fn) == "add_periodic_task":
                pos = map_inside.py_positional(args)
                if len(pos) >= 2:
                    target = pos[1]
                    inner = target.child_by_field_name("function") if target.type == "call" else target
                    handler = map_inside.py_last(inner.child_by_field_name("object")) if inner is not None and inner.type == "attribute" else None
                    out.append({"type": "timer", "file": rel, "line": node.start_point[0] + 1, "schedule": node_text(pos[0]), "handler": handler})
    return out


def js_cron_fields(root, rel):
    """Objects with a `cron: "<expression>"` field: job definitions. The name or id beside it is the job."""
    out = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != "object":
            continue
        fields = {}
        for pair in node.named_children:
            if pair.type != "pair":
                continue
            key, value = pair.child_by_field_name("key"), pair.child_by_field_name("value")
            if key is None or value is None:
                continue
            fields[wiki_calls.text(key).strip("\"'")] = (value, pair)
        if "cron" not in fields:
            continue
        value, pair = fields["cron"]
        expression = map_inside.js_str(value) if value.type in ("string", "template_string") else None
        if not expression or len(expression.split()) < 5:
            continue
        name = None
        for field in ("name", "id", "event"):
            if field in fields and fields[field][0].type == "string":
                name = map_inside.js_str(fields[field][0])
                break
        out.append({"type": "timer", "file": rel, "line": pair.start_point[0] + 1, "schedule": expression, "handler": name})
    return out


# ---- The pass --------------------------------------------------------------------------------------


def read_files(src, errors):
    parsers = {}
    entries, calls, scanned = [], [], 0
    for rel in source_files(src):
        path = inside(src, rel)
        suffix = Path(rel).suffix.lower()
        kind = wiki_calls.LANGS.get(suffix)
        if path is None or kind is None or is_test(rel) or path.stat().st_size > MAX_BYTES:
            continue
        parser = parsers.setdefault(suffix, Parser(kind[1]))
        try:
            data = path.read_bytes()
            tree = parser.parse(data)
        except OSError:
            continue
        scanned += 1
        root = tree.root_node
        try:
            facts = map_inside.scan_js(root, rel, data.count(b"\n") + 1) if kind[0] == "js" else map_inside.scan_python(root, rel, data.count(b"\n") + 1)
            for raw in facts.entries:
                got = entry_of(raw, rel)
                if got is not None:
                    entries.append(got)
            entries.extend(js_cron_fields(root, rel) if kind[0] == "js" else py_schedules(root, rel))
            calls.extend(wiki_calls.js_sites(root, rel) if kind[0] == "js" else wiki_calls.py_sites(root, rel))
        except Exception as err:  # noqa: BLE001 one file the grammars choke on must not lose the rest
            if len(errors) < 20:
                errors.append(f"{rel}: {type(err).__name__}")
    return scanned, entries[:MAX_ENTRIES], sorted(calls, key=lambda c: (c["file"], c["line"]))[:MAX_CALLS]


def facts_pass(src, cache):
    errors = []
    try:
        routes = noir_routes(src)
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as err:
        routes = []
        errors.append(f"noir: {err}")
    scanned, entries, calls = read_files(src, errors)
    out = {"v": READER_VERSION, "files": scanned, "routes": routes, "entries": entries, "calls": calls, "errors": errors}
    tmp = cache / "reader.json.tmp"
    tmp.write_text(json.dumps(out))
    tmp.replace(cache / "reader.json")


def hash_files(src):
    """sha256 of every file graphify could read, by relative path: the picture of the export the graph was made from."""
    out = {}
    for root, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not d.startswith("."))
        for name in sorted(names):
            path = Path(root) / name
            if len(out) >= MAX_GRAPH_FILES:
                return out
            if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_GRAPH_BYTES:
                continue
            out[path.relative_to(src).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def full_update(src, graph):
    """graphify's own `update`. It refuses a graph that would shrink, so a repo that lost files is read again with `--force`."""
    env = {**os.environ, "GRAPHIFY_OUT": str(graph), "GRAPHIFY_NO_AUTO_REFRESH": "1"}
    binary = os.environ.get("MAJHI_GRAPHIFY_BIN", "/opt/graphify/bin/graphify")

    def update(*extra):
        return subprocess.run([binary, "update", str(src), *extra], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)

    done = update()
    if done.returncode != 0:
        done = update("--force")
    if done.returncode != 0 or not (graph / "graph.json").is_file():
        sys.stderr.write((done.stdout + done.stderr)[-2000:])
        sys.exit(done.returncode or 1)


def incremental_update(src, graph, changed):
    """graphify's incremental rebuild of the files that changed. False when it could not, and the caller reads everything."""
    os.environ["GRAPHIFY_OUT"] = str(graph)
    os.environ["GRAPHIFY_NO_AUTO_REFRESH"] = "1"
    try:
        from graphify.watch import _rebuild_code  # a private function: graphify is pinned in the Dockerfile

        return bool(_rebuild_code(src, changed_paths=[src / rel for rel in changed], acquire_lock=False))
    except Exception as err:  # noqa: BLE001 any failure means a full read
        sys.stderr.write(f"incremental graph update failed: {type(err).__name__}\n")
        return False


def graph_pass(src, cache):
    """
    Updates the code graph in <cache>/graph. Every export is a new folder with new file times, so changes are found by
    content: the hashes of the last pass (graph-state.json) against this export. Few changes are rebuilt incrementally
    (about 15 s); a first run, a big change or a failure reads everything (about a minute).
    """
    graph = cache / "graph"
    graph.mkdir(parents=True, exist_ok=True)
    state_file = cache / "graph-state.json"
    now = hash_files(src)
    try:
        before = json.loads(state_file.read_text())
    except (OSError, ValueError):
        before = None
    done = False
    if before is not None and (graph / "graph.json").is_file():
        changed = sorted(p for p in now if before.get(p) != now[p]) + sorted(p for p in before if p not in now)
        if not changed:
            done = True
        elif len(changed) <= max(50, len(now) // 4):
            done = incremental_update(src, graph, changed)
    if not done:
        full_update(src, graph)
    # The page it draws is large and nothing reads it; graphify also keeps a dated copy of the last graph.
    (graph / "graph.html").unlink(missing_ok=True)
    for entry in graph.iterdir():
        if entry.is_dir() and len(entry.name) == 10 and entry.name[4] == "-" and entry.name[7] == "-":
            shutil.rmtree(entry, ignore_errors=True)
    tmp = cache / "graph-state.json.tmp"
    tmp.write_text(json.dumps(now))
    tmp.replace(state_file)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        sys.exit("usage: wiki_facts.py <export folder> <cache folder> [--graph]")
    src, cache = Path(args[0]).resolve(), Path(args[1]).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    if "--graph" in sys.argv:
        graph_pass(src, cache)
    else:
        facts_pass(src, cache)


main()
