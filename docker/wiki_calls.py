"""The HTTP calls a project makes to an address written in its files, for the wiki's `endpoint` facts.

Imported by wiki_facts.py, which runs in a runner container with no network and the project mounted read-only.

graphify records functions, files and the calls between them, not a call to `fetch` or `requests.get`, so the
call sites are found here with the tree-sitter grammars graphify installs. A call site is a call whose first
argument is an address written in the file: a string, a template or f-string that starts with one, a name set
once in the same file to one, or an environment read with an address as its default. Only the scheme, host and
port leave this module: a password, a path or a query never does.
"""

from urllib.parse import urlsplit

import tree_sitter_javascript
import tree_sitter_python
import tree_sitter_typescript
from tree_sitter import Language, Parser

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


# ---- Method and path of a call ------------------------------------------------------------------------
#
# The cross-repo links of a workspace match a call's method and path to a route of another repo. A call here is
# the same kind of call site as above, but its address may be a path only (`/api/v1/items`), because the client
# has its base set elsewhere. Only the method, the path and the host leave this module. A header, a body, a query
# string, a value of a setting and a path part that looks like a secret never do.

PARAM = "{}"
METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
# A call on one of these is how a server declares a route (`app.get("/items", handler)`), not a request.
SERVER_NAMES = {"app", "router", "server", "routes", "route", "fastify", "hono", "koa", "express", "bp", "blueprint"}
JS_FUNCTIONS = {"arrow_function", "function_expression", "function", "generator_function"}
SECRET_MIN = 24


def looks_secret(part):
    """A path part of letters and digits only, long, with both: a token that sits in a URL, never a name."""
    return len(part) >= SECRET_MIN and part.isalnum() and any(c.isdigit() for c in part) and any(c.isalpha() for c in part)


def split_request(raw):
    """(address or None, path) of the first argument of a call, or None when it is not a request path.

    `raw` is the argument's text with PARAM where the code fills a part in at run time. A base that is only known at
    run time (`${API_URL}/items`) gives no address and the path after it. The query and the fragment are dropped.
    """
    raw = raw.strip()
    addr = None
    if raw.startswith(PARAM):
        path = raw[len(PARAM):]
        if not path.startswith("/"):
            return None
    elif raw.startswith("/"):
        if raw.startswith("//"):
            return None
        path = raw
    else:
        try:
            parts = urlsplit(raw)
        except ValueError:
            return None
        addr = address_of(raw)
        if addr is None or PARAM in addr["host"]:
            return None
        path = parts.path
        if path == "":
            return None
    path = path.split("?", 1)[0].split("#", 1)[0]
    out = []
    for part in path.split("/"):
        if part == "":
            continue
        if part in (".", "..") or "\\" in part or "\0" in part:
            return None
        if PARAM in part:
            out.append(PARAM)
        elif looks_secret(part):
            return None
        else:
            out.append(part)
    return addr, "/" + "/".join(out)


def request_row(rel, line, method, raw):
    got = split_request(raw) if raw is not None else None
    if got is None:
        return None
    addr, path = got
    row = {"file": rel, "line": line, "method": method, "path": path}
    if addr is not None:
        row.update(addr)
    return row


def last_name(text_):
    return text_.replace("?", "").split(".")[-1].strip().lower()


# JavaScript and TypeScript


def js_flat(node, consts, depth=0):
    """The text of an expression with PARAM for what is only known at run time, or None when it is not text."""
    node = js_unwrap(node)
    if node is None or depth > 4:
        return None
    if node.type == "string":
        return js_string(node)
    if node.type == "template_string":
        out = ""
        for c in node.children:
            if c.type == "string_fragment":
                out += text(c)
            elif c.type == "template_substitution":
                inner = c.named_child(0) if c.named_child_count > 0 else None
                got = js_flat(inner, consts, depth + 1) if inner is not None else None
                out += got if got is not None else PARAM
        return out
    if node.type == "identifier":
        found = consts.get(text(node))
        return js_flat(found, consts, depth + 1) if found is not None else None
    if node.type == "binary_expression":
        op = node.child_by_field_name("operator")
        left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
        if op is None or left is None or right is None:
            return None
        if text(op) in ("??", "||"):
            if js_env_key(left) is not None:
                return js_flat(right, consts, depth + 1)
            return js_flat(left, consts, depth + 1)
        if text(op) == "+":
            l, r = js_flat(left, consts, depth + 1), js_flat(right, consts, depth + 1)
            return (l if l is not None else PARAM) + (r if r is not None else PARAM)
    return None


def js_property(obj, name):
    """The value node of the property `name` in an object literal, "shorthand" when it is written as `{ name }`, else None."""
    if obj is None or obj.type != "object":
        return None
    for pair in obj.named_children:
        if pair.type == "pair":
            key = pair.child_by_field_name("key")
            if key is not None and text(key).strip("\"'") == name:
                return pair.child_by_field_name("value")
        elif pair.type == "shorthand_property_identifier" and text(pair) == name:
            return "shorthand"
    return None


def method_of(value, default):
    """The HTTP method a `method:` value names when it is a string literal, ANY when it is anything else."""
    if value is None:
        return default
    node = None if value == "shorthand" else js_unwrap(value)
    name = js_string(node) if node is not None and node.type == "string" else None
    if name is not None and name.lower() in METHODS:
        return name.upper()
    return "ANY"


def options_method(options, default):
    """The method an options object names. No options: the default. Options that are not an object literal: ANY."""
    if options is None:
        return default
    options = js_unwrap(options)
    if options is None or options.type != "object":
        return "ANY"
    return method_of(js_property(options, "method"), default)


def js_request_sites(root, rel):
    consts = js_consts(root)
    rows = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != "call_expression":
            continue
        fn = js_unwrap(node.child_by_field_name("function"))
        args = node.child_by_field_name("arguments")
        if fn is None or args is None or args.named_child_count == 0:
            continue
        rest = args.named_children[1:]
        if any(a.type in JS_FUNCTIONS for a in rest):
            continue
        first = js_unwrap(args.named_child(0))
        if first is None:
            continue
        config = first if first.type == "object" else None
        fixed = None  # a verb call names its method itself
        if fn.type == "identifier" and text(fn) in BARE_CLIENTS:
            options = config if config is not None else (rest[0] if rest else None)
            method = options_method(options, "GET")
        elif fn.type == "identifier" and text(fn) == "axios" and config is not None:
            method = options_method(config, "GET")
        elif fn.type == "member_expression":
            prop, obj = fn.child_by_field_name("property"), fn.child_by_field_name("object")
            if prop is None or obj is None or text(prop) not in VERBS or last_name(text(obj)) in SERVER_NAMES:
                continue
            verb = text(prop)
            if verb in METHODS:
                method = verb.upper()
            else:
                options = config if config is not None else (rest[0] if rest else None)
                method = options_method(options, "ANY")
        else:
            continue
        url = js_property(config, "url") if config is not None else first
        if url is None or url == "shorthand":
            continue
        row = request_row(rel, node.start_point[0] + 1, method, js_flat(url, consts))
        if row is not None:
            rows.append(row)
    return rows


# Python


def py_flat(node, consts, depth=0):
    """The text of an expression with PARAM for what is only known at run time, or None when it is not text."""
    if node is None or depth > 4:
        return None
    if node.type == "string":
        out = ""
        for c in node.children:
            if c.type == "string_content":
                out += text(c)
            elif c.type == "interpolation":
                inner = c.child_by_field_name("expression") or (c.named_child(0) if c.named_child_count > 0 else None)
                got = py_flat(inner, consts, depth + 1)
                out += got if got is not None else PARAM
        return out
    if node.type == "identifier":
        found = consts.get(text(node))
        return py_flat(found, consts, depth + 1) if found is not None else None
    env = py_env_default(node)
    if env is not None:
        return py_flat(env[1], consts, depth + 1)
    if node.type == "boolean_operator":
        left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
        if left is not None and py_env_default(left) is not None:
            return py_flat(right, consts, depth + 1)
        return py_flat(left, consts, depth + 1)
    if node.type == "binary_operator":
        left, right = node.child_by_field_name("left"), node.child_by_field_name("right")
        l, r = py_flat(left, consts, depth + 1), py_flat(right, consts, depth + 1)
        return (l if l is not None else PARAM) + (r if r is not None else PARAM)
    return None


def py_request_sites(root, rel):
    consts = py_consts(root)
    rows = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type != "call" or (node.parent is not None and node.parent.type == "decorator"):
            continue
        fn, args = node.child_by_field_name("function"), node.child_by_field_name("arguments")
        if fn is None or args is None or fn.type != "attribute":
            continue
        attr, obj = fn.child_by_field_name("attribute"), fn.child_by_field_name("object")
        if attr is None or obj is None or text(attr) not in VERBS:
            continue
        name = last_name(text(obj))
        if name in SERVER_NAMES or name.endswith("router") or name.endswith("_app"):
            continue
        positional = [a for a in args.named_children if a.type != "keyword_argument"]
        verb = text(attr)
        if verb in METHODS:
            method, url = verb.upper(), (positional[0] if positional else None)
        else:
            # requests.request("POST", url), httpx.stream("GET", url)
            named = py_flat(positional[0], consts) if positional else None
            method = named.upper() if named is not None and named.lower() in METHODS else "ANY"
            url = positional[1] if len(positional) > 1 else None
        if url is None:
            continue
        row = request_row(rel, node.start_point[0] + 1, method, py_flat(url, consts))
        if row is not None:
            rows.append(row)
    return rows
