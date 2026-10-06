#!/opt/graphify/bin/python
"""Reads one project for the map (SPEC 5.21): graphify's code graph, and the addresses its HTTP client calls use.

Usage: map-extract.py <project folder> <output folder>

Runs in a runner container with no network, the project mounted read-only and only the output folder
writable. It writes, in the output folder:

  graph.json         graphify's own graph (`graphify update`), kept with its cache for the next run
  majhi-facts.json   the call sites graphify does not record: an HTTP client called with an address

graphify records functions, files and the calls between them, not a call to `fetch` or `requests.get`,
so the second file is made here with the tree-sitter grammars graphify installs. A call site is a call
whose first argument is an address written in the file: a string, a template or f-string that starts with
one, a name set once in the same file to one, or an environment read with an address as its default.
Only the scheme, host and port leave this script: a password, a path or a query never does.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import map_inside  # noqa: E402
import map_resolve  # noqa: E402
import tree_sitter_javascript
import tree_sitter_python
import tree_sitter_typescript
from tree_sitter import Language, Parser

MAX_FILES = 4000
MAX_BYTES = 512 * 1024
SCHEMES = {"http", "https", "ws", "wss"}
VERBS = {"get", "post", "put", "patch", "delete", "head", "options", "request", "stream"}
BARE_CLIENTS = {"fetch", "got", "ky", "ofetch", "$fetch"}

LANGS = {
    ".js": ("js", Language(tree_sitter_javascript.language())),
    ".jsx": ("js", Language(tree_sitter_javascript.language())),
    ".mjs": ("js", Language(tree_sitter_javascript.language())),
    ".cjs": ("js", Language(tree_sitter_javascript.language())),
    ".ts": ("js", Language(tree_sitter_typescript.language_typescript())),
    ".mts": ("js", Language(tree_sitter_typescript.language_typescript())),
    ".tsx": ("js", Language(tree_sitter_typescript.language_tsx())),
    ".py": ("py", Language(tree_sitter_python.language())),
}


def text(node):
    return node.text.decode("utf-8", "replace")


def address_of(raw):
    """scheme, host, port of an address, or None when it is not an absolute http(s) or ws(s) address."""
    try:
        parts = urlsplit(raw.strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in SCHEMES or not host:
        return None
    return {"scheme": parts.scheme.lower(), "host": host.lower(), "port": port}


# ---- JavaScript and TypeScript ------------------------------------------------------------------

JS_WRAPPERS = {"parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "await_expression"}


def js_unwrap(node):
    while node is not None and node.type in JS_WRAPPERS and node.named_child_count > 0:
        node = node.named_child(0)
    return node


def js_string(node):
    """The text of a string literal, or of the literal start of a template, else None."""
    if node.type == "string":
        return "".join(text(c) for c in node.children if c.type == "string_fragment")
    if node.type == "template_string":
        out = ""
        for c in node.children:
            if c.type == "string_fragment":
                out += text(c)
            elif c.type == "template_substitution":
                break
        return out
    return None


def js_env_key(node):
    """NAME of `process.env.NAME`, `process.env["NAME"]` or `import.meta.env.NAME`."""
    node = js_unwrap(node)
    if node is None:
        return None
    if node.type == "member_expression":
        obj, prop = node.child_by_field_name("object"), node.child_by_field_name("property")
        if obj is not None and prop is not None and text(obj) in ("process.env", "import.meta.env"):
            return text(prop)
    if node.type == "subscript_expression":
        obj, idx = node.child_by_field_name("object"), node.child_by_field_name("index")
        if obj is not None and idx is not None and text(obj) in ("process.env", "import.meta.env"):
            return js_string(idx)
    return None


def js_value(node, consts, depth=0):
    """(address text, how, env key): how is `literal` or `env-default`. None when the file does not say."""
    node = js_unwrap(node)
    if node is None or depth > 3:
        return None
    s = js_string(node)
    if s is not None and not (node.type == "template_string" and s == "" and node.named_child_count > 0):
        return (s, "literal", None)
    if node.type == "identifier":
        found = consts.get(text(node))
        return js_value(found, consts, depth + 1) if found is not None else None
    if node.type == "binary_expression":
        op = node.child_by_field_name("operator")
        left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
        if op is not None and text(op) in ("??", "||") and left is not None and right is not None:
            key = js_env_key(left)
            if key is not None:
                got = js_value(right, consts, depth + 1)
                return (got[0], "env-default", key) if got is not None else None
        if op is not None and text(op) == "+" and left is not None:
            return js_value(left, consts, depth + 1)
    if node.type == "template_string":
        # Starts with a name: `${API}/orders`.
        subs = [c for c in node.children if c.type in ("string_fragment", "template_substitution")]
        if subs and subs[0].type == "template_substitution" and subs[0].named_child_count > 0:
            got = js_value(subs[0].named_child(0), consts, depth + 1)
            if got is not None:
                rest = "".join(text(c) for c in subs[1:] if c.type == "string_fragment")
                return (got[0] + rest, got[1], got[2])
    return None


def js_consts(root):
    """Top-level `const NAME = <value>` of a file."""
    out = {}
    for stmt in root.named_children:
        decl = stmt
        if stmt.type == "export_statement":
            decl = stmt.child_by_field_name("declaration") or stmt
        if decl.type not in ("lexical_declaration", "variable_declaration"):
            continue
        for d in decl.named_children:
            name, value = d.child_by_field_name("name"), d.child_by_field_name("value")
            if d.type == "variable_declarator" and name is not None and name.type == "identifier" and value is not None:
                out[text(name)] = value
    return out


def js_client(fn):
    """The client's name when the callee is an HTTP call: fetch(...), or <anything>.get|post|...(...)."""
    fn = js_unwrap(fn)
    if fn is None:
        return None
    if fn.type == "identifier" and text(fn) in BARE_CLIENTS:
        return text(fn), True
    if fn.type == "member_expression":
        prop = fn.child_by_field_name("property")
        if prop is not None and text(prop) in VERBS:
            return text(fn), False
    return None


def js_sites(root, rel):
    consts = js_consts(root)
    sites = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != "call_expression":
            continue
        client = js_client(node.child_by_field_name("function"))
        args = node.child_by_field_name("arguments")
        if client is None or args is None or args.named_child_count == 0:
            continue
        value = js_value(args.named_child(0), consts)
        if value is None:
            continue
        addr = address_of(value[0])
        if addr is None:
            continue
        sites.append({"file": rel, "line": node.start_point[0] + 1, "client": client[0], "how": value[1], "key": value[2], **addr})
    return sites


# ---- Python -------------------------------------------------------------------------------------


def py_string(node):
    if node.type == "string":
        out = ""
        for c in node.children:
            if c.type == "string_content":
                out += text(c)
            elif c.type == "interpolation":
                break
        return out
    return None


def py_env_default(node):
    """(key, default node) of os.environ.get("K", d), os.getenv("K", d)."""
    if node.type != "call":
        return None
    fn, args = node.child_by_field_name("function"), node.child_by_field_name("arguments")
    if fn is None or args is None or text(fn) not in ("os.environ.get", "os.getenv") or args.named_child_count < 1:
        return None
    key = py_string(args.named_child(0))
    default = args.named_child(1) if args.named_child_count > 1 else None
    return (key, default)


def py_value(node, consts, depth=0):
    if node is None or depth > 3:
        return None
    s = py_string(node)
    if s is not None:
        return (s, "literal", None)
    if node.type == "identifier":
        found = consts.get(text(node))
        return py_value(found, consts, depth + 1) if found is not None else None
    env = py_env_default(node)
    if env is not None:
        got = py_value(env[1], consts, depth + 1)
        return (got[0], "env-default", env[0]) if got is not None else None
    if node.type == "boolean_operator" and node.child_by_field_name("left") is not None:
        left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
        if py_env_default(left) is not None or left.type == "call":
            key = py_env_default(left)
            got = py_value(right, consts, depth + 1)
            return (got[0], "env-default", key[0] if key else None) if got is not None else None
    if node.type == "binary_operator" and node.child_by_field_name("left") is not None:
        return py_value(node.child_by_field_name("left"), consts, depth + 1)
    return None


def py_consts(root):
    out = {}
    for stmt in root.named_children:
        if stmt.type != "expression_statement" or stmt.named_child_count == 0:
            continue
        a = stmt.named_child(0)
        if a.type == "assignment":
            left, right = a.child_by_field_name("left"), a.child_by_field_name("right")
            if left is not None and left.type == "identifier" and right is not None:
                out[text(left)] = right
    return out


def py_sites(root, rel):
    consts = py_consts(root)
    sites = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != "call":
            continue
        fn, args = node.child_by_field_name("function"), node.child_by_field_name("arguments")
        if fn is None or args is None or args.named_child_count == 0:
            continue
        attr = fn.child_by_field_name("attribute") if fn.type == "attribute" else None
        if attr is None or text(attr) not in VERBS:
            continue
        first = args.named_child(0)
        if first.type == "keyword_argument":
            continue
        value = py_value(first, consts)
        if value is None:
            continue
        addr = address_of(value[0])
        if addr is None:
            continue
        sites.append({"file": rel, "line": node.start_point[0] + 1, "client": text(fn), "how": value[1], "key": value[2], **addr})
    return sites


# ---- Run ----------------------------------------------------------------------------------------


def graph_files(out):
    """The files graphify read, from its own graph: it already skips what a project ignores."""
    try:
        graph = json.loads((out / "graph.json").read_text())
    except (OSError, ValueError):
        return []
    files = {n.get("source_file") for n in graph.get("nodes", []) if isinstance(n.get("source_file"), str)}
    return sorted(files)


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: map-extract.py <project folder> <output folder>")
    src, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "GRAPHIFY_OUT": str(out), "GRAPHIFY_NO_AUTO_REFRESH": "1"}
    update = subprocess.run(
        [os.environ.get("MAJHI_GRAPHIFY_BIN", "/opt/graphify/bin/graphify"), "update", str(src), "--force"],
        env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
    )
    if update.returncode != 0 or not (out / "graph.json").is_file():
        sys.stderr.write((update.stdout + update.stderr)[-2000:])
        sys.exit(update.returncode or 1)

    # The page it draws is large and nothing here reads it.
    (out / "graph.html").unlink(missing_ok=True)

    parsers = {}
    sites, scanned, inside = [], 0, []
    for rel in graph_files(out)[:MAX_FILES]:
        path = (src / rel)
        kind = LANGS.get(path.suffix.lower())
        if kind is None or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
            continue
        parser = parsers.setdefault(path.suffix.lower(), Parser(kind[1]))
        try:
            data = path.read_bytes()
            tree = parser.parse(data)
            nlines = data.count(b"\n") + 1
        except OSError:
            continue
        scanned += 1
        found = js_sites(tree.root_node, rel) if kind[0] == "js" else py_sites(tree.root_node, rel)
        sites.extend(found)
        try:
            inside.append(
                map_inside.scan_js(tree.root_node, rel, nlines) if kind[0] == "js" else map_inside.scan_python(tree.root_node, rel, nlines)
            )
        except RecursionError:
            pass
    sites.sort(key=lambda s: (s["file"], s["line"]))
    facts = {"v": 3, "files": scanned, "calls": sites[:2000], "inside": map_resolve.assemble(inside, map_resolve.collect_meta(src))}
    tmp = out / "majhi-facts.json.tmp"
    tmp.write_text(json.dumps(facts))
    tmp.replace(out / "majhi-facts.json")


main()
