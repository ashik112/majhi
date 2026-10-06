"""What is inside one project, for the map's Inside tab (SPEC 5.21). Imported by map-extract.py.

Reads source files with tree-sitter (no model, no network) and returns plain facts:

  defs     functions: name, file, line, end line, the first line of the docstring or comment above it
  calls    one function calling another function of the same project (by name), with the line
  entries  what starts work: an HTTP route, a schedule, a queue consumer, a command, with the function it runs
  uses     a function using a known datastore or outside service through its client library, with the line

Frameworks it knows: Python (FastAPI, Flask, Django urls, Celery, APScheduler, schedule, click, typer) and
JavaScript or TypeScript (Express, Fastify, Hono, Koa, Next.js route files, node-cron, BullMQ, commander).
A call site or a library it does not know is left out; nothing here guesses from a name alone.
"""

import os

HTTP_VERBS = {"get", "post", "put", "patch", "delete", "head", "options"}
JS_HTTP_VERBS = HTTP_VERBS | {"all"}
READ_WORDS = ("get", "find", "select", "read", "fetch", "list", "query", "scan", "lrange", "hget", "exists", "count", "search", "load")
WRITE_WORDS = ("set", "insert", "add", "save", "write", "put", "push", "lpush", "rpush", "update", "delete", "create", "remove", "enqueue", "send", "publish", "post")

# Library (first part of the module name) -> (display name, kind). Names match the web page's logo table.
STORES = {
    "psycopg2": ("Postgres", "db"), "psycopg": ("Postgres", "db"), "asyncpg": ("Postgres", "db"), "pg": ("Postgres", "db"),
    "postgres": ("Postgres", "db"), "pymysql": ("MySQL", "db"), "mysqlclient": ("MySQL", "db"), "mysql2": ("MySQL", "db"),
    "pymongo": ("MongoDB", "db"), "motor": ("MongoDB", "db"), "mongodb": ("MongoDB", "db"), "mongoose": ("MongoDB", "db"),
    "redis": ("Redis", "db"), "aioredis": ("Redis", "db"), "ioredis": ("Redis", "db"), "bullmq": ("Redis", "db"), "bull": ("Redis", "db"),
    "pika": ("RabbitMQ", "db"), "amqplib": ("RabbitMQ", "db"), "kafka": ("Kafka", "db"), "kafkajs": ("Kafka", "db"),
    "confluent_kafka": ("Kafka", "db"), "sqlite3": ("SQLite", "db"), "@elastic/elasticsearch": ("Elasticsearch", "db"),
}
OUTSIDE = {
    "stripe": "Stripe", "openai": "OpenAI", "anthropic": "Anthropic", "@anthropic-ai/sdk": "Anthropic",
    "sentry_sdk": "Sentry", "@sentry/node": "Sentry", "twilio": "Twilio", "sendgrid": "SendGrid", "@sendgrid/mail": "SendGrid",
    "slack_sdk": "Slack", "@slack/web-api": "Slack", "resend": "Resend", "replicate": "Replicate",
    "telegram": "Telegram", "telebot": "Telegram", "aiogram": "Telegram", "grammy": "Telegram", "telegraf": "Telegram",
    "github": "GitHub", "@octokit/rest": "GitHub", "exa_py": "Exa", "exa-js": "Exa", "firecrawl": "Firecrawl",
    "@mendable/firecrawl-js": "Firecrawl", "firecrawl_py": "Firecrawl",
}


def service_of(module):
    """(name, kind) of a library, or None. `module` is `a.b.c` or `@scope/pkg/sub`."""
    if module.startswith("@"):
        root = "/".join(module.split("/")[:2])
    else:
        root = module.split("/")[0].split(".")[0]
    if root in STORES:
        return STORES[root]
    if root in OUTSIDE:
        return (OUTSIDE[root], "out")
    return None


def verb_of(method):
    low = (method or "").lower()
    if any(low.startswith(w) for w in WRITE_WORDS):
        return "write"
    if any(low.startswith(w) for w in READ_WORDS):
        return "read"
    return "use"


def humanize_cron(expr):
    """A readable label for a five-field cron expression, or the expression itself."""
    parts = expr.split()
    if len(parts) < 5:
        return expr
    minute, hour, dom, month, dow = parts[:5]
    if minute.startswith("*/") and hour == "*" and dom == month == dow == "*":
        return f"every {minute[2:]} minutes"
    if minute.isdigit() and hour.isdigit() and dom == month == dow == "*":
        return f"daily {int(hour):02d}:{int(minute):02d}"
    if minute.isdigit() and hour == "*" and dom == month == dow == "*":
        return f"hourly at :{int(minute):02d}"
    return expr


class FileFacts:
    """Facts of one file, collected by `scan`."""

    def __init__(self, rel):
        self.rel = rel
        self.defs = []  # {name,line,end,doc,node_range}
        self.calls = []  # (line, callee name)
        self.entries = []  # {kind,label,line,fn (name) or None, span (start,end) for anonymous handler}
        self.uses = []  # (line, service, kind, verb)


def line_of(node):
    return node.start_point[0] + 1


def text_of(node):
    return node.text.decode("utf-8", "replace")


SQL_READ = {"select"}
SQL_WRITE = {"insert", "update", "delete", "replace", "upsert"}


def use_of(svc, method, first_arg):
    """(verb, target) of a call on a client: SQL text names its verb and table; else the method's name decides."""
    if svc[1] != "db":
        return ("call", None)
    if first_arg:
        words = first_arg.lower().split()
        if words and (words[0] in SQL_READ or words[0] in SQL_WRITE):
            verb = "read" if words[0] in SQL_READ else "write"
            target = None
            for i, w in enumerate(words[:-1]):
                if w in ("into", "from", "update", "table"):
                    target = words[i + 1].strip("`\"'();,").split(".")[-1] or None
                    break
            if words[0] == "update" and len(words) > 1:
                target = words[1].strip("`\"'();,").split(".")[-1] or None
            return (verb, target)
    return (verb_of(method), None)


def first_line(raw, limit=90):
    for ln in raw.strip().splitlines():
        ln = ln.strip().lstrip("/*#! ").strip()
        ln = ln[:-2].strip() if ln.endswith("*/") else ln
        if ln and not ln.startswith("@"):
            return ln[:limit]
    return ""


# ------------------------------------------------------------------------------------------------
# Python


def py_str(node):
    if node is None or node.type != "string":
        return None
    out = ""
    for c in node.children:
        if c.type == "string_content":
            out += text_of(c)
        elif c.type == "interpolation":
            return None
    return out


def py_root(node):
    """The leftmost identifier of `a.b.c(...)`, `a[0].b`, `a().b`, else None."""
    while node is not None:
        if node.type == "identifier":
            return text_of(node)
        if node.type == "attribute":
            node = node.child_by_field_name("object")
        elif node.type == "call":
            node = node.child_by_field_name("function")
        elif node.type in ("subscript", "await", "parenthesized_expression"):
            node = node.named_child(0) if node.named_child_count else None
        else:
            return None
    return None


def py_last(node):
    if node is None:
        return None
    if node.type == "identifier":
        return text_of(node)
    if node.type == "attribute":
        return text_of(node.child_by_field_name("attribute"))
    return None


def py_kwargs(args):
    out = {}
    if args is None:
        return out
    for a in args.named_children:
        if a.type == "keyword_argument":
            name, val = a.child_by_field_name("name"), a.child_by_field_name("value")
            if name is not None and val is not None:
                out[text_of(name)] = val
    return out


def py_positional(args):
    return [a for a in args.named_children if a.type != "keyword_argument"] if args is not None else []


def py_docstring(func):
    body = func.child_by_field_name("body")
    if body is None or body.named_child_count == 0:
        return ""
    first = body.named_child(0)
    if first.type == "expression_statement" and first.named_child_count and first.named_child(0).type == "string":
        s = py_str(first.named_child(0))
        return first_line(s) if s else ""
    return ""


def py_schedule_label(kind, kwargs, positional):
    if kind == "cron":
        h, m = kwargs.get("hour"), kwargs.get("minute")
        if h is not None and h.type == "integer":
            mm = int(text_of(m)) if m is not None and m.type == "integer" else 0
            return f"daily {int(text_of(h)):02d}:{mm:02d}"
        return "cron"
    if kind == "interval":
        for unit in ("seconds", "minutes", "hours", "days"):
            if unit in kwargs and kwargs[unit].type == "integer":
                return f"every {text_of(kwargs[unit])} {unit}"
        return "interval"
    return kind


def py_decorator_entry(dec, fn_name, line):
    """The entry a decorator makes of the function it decorates, or None."""
    expr = dec.named_child(0) if dec.named_child_count else None
    if expr is None:
        return None
    call, args = (expr, expr.child_by_field_name("arguments")) if expr.type == "call" else (None, None)
    callee = expr.child_by_field_name("function") if call is not None else expr
    method = py_last(callee)
    pos = py_positional(args)
    kw = py_kwargs(args)
    first = py_str(pos[0]) if pos else None
    if method in HTTP_VERBS and first is not None:
        return {"kind": "HTTP", "label": f"{method.upper()} {first}", "line": line, "fn": fn_name}
    if method in ("route", "api_route", "websocket") and first is not None:
        verb = "GET"
        methods = kw.get("methods")
        if methods is not None:
            for s in methods.named_children:
                got = py_str(s)
                if got:
                    verb = got.upper()
                    break
        if method == "websocket":
            verb = "WS"
        return {"kind": "HTTP", "label": f"{verb} {first}", "line": line, "fn": fn_name}
    if method in ("scheduled_job", "periodic_task", "cron", "interval"):
        kind = first if method == "scheduled_job" and first else ("cron" if method == "cron" else method)
        if method == "scheduled_job" and first in ("cron", "interval", "date"):
            return {"kind": "SCHEDULE", "label": py_schedule_label(first, kw, pos), "line": line, "fn": fn_name}
        if method == "periodic_task":
            return {"kind": "SCHEDULE", "label": "periodic", "line": line, "fn": fn_name}
        if first is not None and method == "cron":
            return {"kind": "SCHEDULE", "label": humanize_cron(first), "line": line, "fn": fn_name}
        return {"kind": "SCHEDULE", "label": py_schedule_label(kind, kw, pos), "line": line, "fn": fn_name}
    if method in ("task", "shared_task", "actor"):
        return {"kind": "QUEUE", "label": f"task {fn_name}", "line": line, "fn": fn_name}
    if method == "command":
        label = first if first else fn_name.replace("_", "-")
        return {"kind": "COMMAND", "label": label, "line": line, "fn": fn_name}
    return None


def py_every_label(node):
    """`schedule.every(5).minutes.do(fn)` / `.every().day.at("06:00").do(fn)` -> (label, fn name)."""
    names = []
    cur = node
    fn_name = None
    first = True
    while cur is not None:
        if cur.type == "call":
            fn = cur.child_by_field_name("function")
            args = cur.child_by_field_name("arguments")
            if first:
                first = False
                if py_last(fn) != "do":
                    return None
                pos = py_positional(args)
                fn_name = py_last(pos[0]) if pos else None
            else:
                nm = py_last(fn)
                pos = py_positional(args)
                if nm == "every":
                    names.append("every" + (f" {text_of(pos[0])}" if pos and pos[0].type == "integer" else ""))
                elif nm == "at" and pos and py_str(pos[0]):
                    names.append(f"at {py_str(pos[0])}")
                else:
                    names.append(nm or "")
            cur = fn.child_by_field_name("object") if fn is not None and fn.type == "attribute" else None
        elif cur.type == "attribute":
            names.append(text_of(cur.child_by_field_name("attribute")))
            cur = cur.child_by_field_name("object")
        else:
            break
    if fn_name is None or not names or "every" not in " ".join(names):
        return None
    return (" ".join(reversed([n for n in names if n and n != "schedule"])), fn_name)


def scan_python(root, rel):
    facts = FileFacts(rel)
    bound = {}  # local name -> (service name, kind)
    stack = [root]
    order = []
    while stack:
        n = stack.pop()
        order.append(n)
        stack.extend(reversed(n.children))
    # Imports and bindings first, in file order.
    for n in order:
        if n.type == "import_statement":
            for c in n.named_children:
                mod = c.child_by_field_name("name") if c.type == "aliased_import" else c
                alias = c.child_by_field_name("alias") if c.type == "aliased_import" else None
                if mod is None:
                    continue
                svc = service_of(text_of(mod))
                if svc:
                    bound[text_of(alias) if alias is not None else text_of(mod).split(".")[0]] = svc
        elif n.type == "import_from_statement":
            mod = n.child_by_field_name("module_name")
            svc = service_of(text_of(mod)) if mod is not None else None
            if svc:
                for c in n.named_children:
                    if c is mod:
                        continue
                    nm = c.child_by_field_name("name") if c.type == "aliased_import" else c
                    alias = c.child_by_field_name("alias") if c.type == "aliased_import" else None
                    if nm is not None:
                        bound[text_of(alias) if alias is not None else text_of(nm)] = svc
    for n in order:
        if n.type == "assignment":
            left, right = n.child_by_field_name("left"), n.child_by_field_name("right")
            if left is not None and left.type == "identifier" and right is not None and right.type == "call":
                root_name = py_root(right.child_by_field_name("function"))
                if root_name in bound:
                    bound[text_of(left)] = bound[root_name]
    for n in order:
        if n.type == "function_definition":
            name = text_of(n.child_by_field_name("name"))
            facts.defs.append({"name": name, "line": line_of(n), "end": n.end_point[0] + 1, "doc": py_docstring(n)})
        elif n.type == "decorated_definition":
            definition = n.child_by_field_name("definition")
            if definition is not None and definition.type == "function_definition":
                fname = text_of(definition.child_by_field_name("name"))
                for d in [c for c in n.children if c.type == "decorator"]:
                    got = py_decorator_entry(d, fname, line_of(d))
                    if got:
                        facts.entries.append(got)
        elif n.type == "call":
            fn = n.child_by_field_name("function")
            args = n.child_by_field_name("arguments")
            name = py_last(fn)
            pos = py_positional(args)
            kw = py_kwargs(args)
            if name == "add_job" and pos:
                target = py_last(pos[0])
                kind = py_str(pos[1]) if len(pos) > 1 else None
                if target:
                    label = py_schedule_label(kind or "interval", kw, pos)
                    facts.entries.append({"kind": "SCHEDULE", "label": label, "line": line_of(n), "fn": target})
            elif name == "do":
                got = py_every_label(n)
                if got:
                    facts.entries.append({"kind": "SCHEDULE", "label": got[0], "line": line_of(n), "fn": got[1]})
            elif name in ("path", "re_path", "url") and len(pos) >= 2 and py_str(pos[0]) is not None and py_last(pos[1]):
                facts.entries.append({"kind": "HTTP", "label": f"/{py_str(pos[0])}".rstrip("/") or "/", "line": line_of(n), "fn": py_last(pos[1])})
            if name:
                facts.calls.append((line_of(n), name, py_root(fn)))
            root_name = py_root(fn)
            if root_name in bound and fn is not None:
                method = py_last(fn) if fn.type == "attribute" else None
                svc = bound[root_name]
                verb, target = use_of(svc, method, py_str(pos[0]) if pos else None)
                facts.uses.append((line_of(n), svc[0], svc[1], verb, target))
    return facts


# ------------------------------------------------------------------------------------------------
# JavaScript and TypeScript


def js_str(node):
    if node is None:
        return None
    if node.type == "string":
        return "".join(text_of(c) for c in node.children if c.type == "string_fragment")
    if node.type == "template_string" and all(c.type != "template_substitution" for c in node.children):
        return "".join(text_of(c) for c in node.children if c.type == "string_fragment")
    return None


def js_root(node):
    while node is not None:
        if node.type == "identifier":
            return text_of(node)
        if node.type == "member_expression":
            node = node.child_by_field_name("object")
        elif node.type == "call_expression":
            node = node.child_by_field_name("function")
        elif node.type in ("await_expression", "parenthesized_expression", "non_null_expression", "new_expression"):
            node = node.named_child(0) if node.named_child_count else node.child_by_field_name("constructor")
        else:
            return None
    return None


def js_last(node):
    if node is None:
        return None
    if node.type == "identifier":
        return text_of(node)
    if node.type == "member_expression":
        return text_of(node.child_by_field_name("property"))
    return None


def js_comment_above(node):
    prev = node.prev_named_sibling
    if prev is not None and prev.type == "comment" and prev.end_point[0] + 1 >= node.start_point[0]:
        return first_line(text_of(prev))
    parent = node.parent
    if parent is not None and parent.type == "export_statement":
        prev = parent.prev_named_sibling
        if prev is not None and prev.type == "comment" and prev.end_point[0] + 1 >= parent.start_point[0]:
            return first_line(text_of(prev))
    return ""


def js_module_of(call):
    args = call.child_by_field_name("arguments")
    return js_str(args.named_child(0)) if args is not None and args.named_child_count else None


def route_from_file(rel):
    """The URL of a Next.js route file (`app/api/brief/route.ts` -> /api/brief), or None."""
    parts = rel.split("/")
    name = parts[-1].rsplit(".", 1)[0]
    if "app" in parts and name == "route":
        i = parts.index("app")
        segs = [p for p in parts[i + 1:-1] if not (p.startswith("(") and p.endswith(")"))]
        return "/" + "/".join(segs)
    if "pages" in parts and "api" in parts[parts.index("pages") + 1:]:
        i = parts.index("pages")
        segs = parts[i + 1:-1] + ([] if name == "index" else [name])
        return "/" + "/".join(segs)
    return None


def scan_js(root, rel):
    facts = FileFacts(rel)
    bound = {}
    stack = [root]
    order = []
    while stack:
        n = stack.pop()
        order.append(n)
        stack.extend(reversed(n.children))
    for n in order:
        if n.type == "import_statement":
            src = n.child_by_field_name("source")
            svc = service_of(js_str(src) or "") if src is not None else None
            if svc:
                for c in n.children:
                    if c.type == "import_clause":
                        for d in c.children:
                            if d.type == "identifier":
                                bound[text_of(d)] = svc
                            elif d.type == "namespace_import" and d.named_child_count:
                                bound[text_of(d.named_child(0))] = svc
                            elif d.type == "named_imports":
                                for s in d.named_children:
                                    nm = s.child_by_field_name("alias") or s.child_by_field_name("name")
                                    if nm is not None:
                                        bound[text_of(nm)] = svc
        elif n.type == "variable_declarator":
            name, value = n.child_by_field_name("name"), n.child_by_field_name("value")
            if name is None or value is None:
                continue
            v = value
            while v is not None and v.type == "await_expression" and v.named_child_count:
                v = v.named_child(0)
            if v is not None and v.type == "call_expression":
                fn = v.child_by_field_name("function")
                if fn is not None and text_of(fn) == "require":
                    svc = service_of(js_module_of(v) or "")
                    if svc and name.type == "identifier":
                        bound[text_of(name)] = svc
                    continue
            if v is not None and v.type in ("call_expression", "new_expression"):
                callee = v.child_by_field_name("function") if v.type == "call_expression" else v.child_by_field_name("constructor")
                r = js_root(callee)
                if r in bound and name.type == "identifier":
                    bound[text_of(name)] = bound[r]
    exported = set()
    for n in order:
        if n.type == "function_declaration":
            name = n.child_by_field_name("name")
            if name is not None:
                facts.defs.append({"name": text_of(name), "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(n)})
        elif n.type == "method_definition":
            name = n.child_by_field_name("name")
            if name is not None:
                facts.defs.append({"name": text_of(name), "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(n)})
        elif n.type == "variable_declarator":
            name, value = n.child_by_field_name("name"), n.child_by_field_name("value")
            if name is not None and name.type == "identifier" and value is not None and value.type in ("arrow_function", "function_expression", "function"):
                parent = n.parent.parent if n.parent is not None else None
                facts.defs.append({"name": text_of(name), "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(parent if parent is not None else n)})
        elif n.type == "call_expression":
            fn = n.child_by_field_name("function")
            args = n.child_by_field_name("arguments")
            pos = args.named_children if args is not None else []
            method = js_last(fn)
            first = js_str(pos[0]) if pos else None
            handler = pos[-1] if len(pos) > 1 else None
            if method in JS_HTTP_VERBS and first is not None and first.startswith("/") and handler is not None and fn.type == "member_expression":
                verb = "ANY" if method == "all" else method.upper()
                entry = {"kind": "HTTP", "label": f"{verb} {first}", "line": line_of(n), "fn": None}
                if handler.type in ("arrow_function", "function_expression", "function"):
                    entry["fn"] = f"{verb.lower()} {first}"
                    entry["span"] = (line_of(handler), handler.end_point[0] + 1)
                else:
                    entry["fn"] = js_last(handler)
                facts.entries.append(entry)
            elif method in ("schedule", "scheduleJob") and first is not None and len(pos) > 1:
                entry = {"kind": "SCHEDULE", "label": humanize_cron(first), "line": line_of(n), "fn": js_last(pos[-1])}
                if pos[-1].type in ("arrow_function", "function_expression", "function"):
                    entry["fn"] = f"job {humanize_cron(first)}"
                    entry["span"] = (line_of(pos[-1]), pos[-1].end_point[0] + 1)
                facts.entries.append(entry)
            elif method == "setInterval" and len(pos) > 1 and pos[1].type == "number" and js_last(pos[0]):
                secs = int(float(text_of(pos[1])) / 1000)
                facts.entries.append({"kind": "SCHEDULE", "label": f"every {secs} seconds", "line": line_of(n), "fn": js_last(pos[0])})
            elif method == "action" and handler is None and pos and js_last(pos[0]) and fn.type == "member_expression":
                inner = fn.child_by_field_name("object")
                if inner is not None and inner.type == "call_expression" and js_last(inner.child_by_field_name("function")) == "command":
                    cargs = inner.child_by_field_name("arguments")
                    label = js_str(cargs.named_child(0)) if cargs is not None and cargs.named_child_count else None
                    if label:
                        facts.entries.append({"kind": "COMMAND", "label": label.split()[0], "line": line_of(n), "fn": js_last(pos[0])})
            elif method == "consume" and first is not None and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "QUEUE", "label": f"consumer {first}", "line": line_of(n), "fn": js_last(pos[1])})
            if method:
                facts.calls.append((line_of(n), method, js_root(fn)))
            r = js_root(fn)
            if r in bound and fn is not None:
                svc = bound[r]
                verb, target = use_of(svc, method, first)
                facts.uses.append((line_of(n), svc[0], svc[1], verb, target))
        elif n.type == "new_expression":
            ctor = n.child_by_field_name("constructor")
            args = n.child_by_field_name("arguments")
            pos = args.named_children if args is not None else []
            name = js_last(ctor) if ctor is not None else None
            if name == "Worker" and pos and js_str(pos[0]) and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "QUEUE", "label": f"consumer {js_str(pos[0])}", "line": line_of(n), "fn": js_last(pos[1])})
            elif name == "CronJob" and pos and js_str(pos[0]) and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "SCHEDULE", "label": humanize_cron(js_str(pos[0])), "line": line_of(n), "fn": js_last(pos[1])})
            r = js_root(ctor)
            if r in bound:
                svc = bound[r]
                facts.uses.append((line_of(n), svc[0], svc[1], "call" if svc[1] == "out" else "use", None))
        elif n.type == "export_statement":
            decl = n.child_by_field_name("declaration")
            if decl is not None and decl.type == "function_declaration":
                nm = decl.child_by_field_name("name")
                if nm is not None:
                    exported.add(text_of(nm))
    route = route_from_file(rel)
    if route is not None:
        for d in facts.defs:
            if d["name"] in exported and d["name"].upper() in {v.upper() for v in HTTP_VERBS}:
                facts.entries.append({"kind": "HTTP", "label": f"{d['name'].upper()} {route}", "line": d["line"], "fn": d["name"]})
    return facts


# ------------------------------------------------------------------------------------------------
# One project


def assemble(per_file):
    """Join the files' facts: unique function ids, calls between them, entries, uses."""
    counts = {}
    for f in per_file:
        for d in f.defs:
            counts[d["name"]] = counts.get(d["name"], 0) + 1
    synthetic = []
    for f in per_file:
        for e in f.entries:
            if "span" in e:
                synthetic.append((f, e))
    defs = []
    by_file_name = {}
    for f in per_file:
        stem = os.path.splitext(os.path.basename(f.rel))[0]
        for d in f.defs:
            fid = d["name"] if counts[d["name"]] == 1 else f"{stem}.{d['name']}"
            defs.append({"id": fid, "name": d["name"], "file": f.rel, "line": d["line"], "end": d["end"], "doc": d["doc"]})
            by_file_name[(f.rel, d["name"])] = fid
    for f, e in synthetic:
        start, end = e["span"]
        defs.append({"id": e["fn"], "name": e["fn"], "file": f.rel, "line": start, "end": end, "doc": ""})
        by_file_name[(f.rel, e["fn"])] = e["fn"]
    by_name = {}
    for d in defs:
        by_name.setdefault(d["name"], []).append(d)

    def resolve(name, rel):
        cands = by_name.get(name, [])
        if len(cands) == 1:
            return cands[0]["id"]
        same = [c for c in cands if c["file"] == rel]
        return same[0]["id"] if len(same) == 1 else None

    in_file = {}
    for d in defs:
        in_file.setdefault(d["file"], []).append(d)

    def enclosing(rel, line):
        best = None
        for d in in_file.get(rel, []):
            if d["line"] <= line <= d["end"]:
                if best is None or (d["end"] - d["line"]) < (best["end"] - best["line"]):
                    best = d
        return best["id"] if best else None

    calls, uses, entries = {}, {}, []
    for f in per_file:
        for line, name, _root in f.calls:
            src = enclosing(f.rel, line)
            dst = resolve(name, f.rel)
            if src and dst and src != dst:
                calls.setdefault((src, dst), line)
        for line, svc, kind, verb, target in f.uses:
            src = enclosing(f.rel, line)
            if src:
                key = (src, svc, kind, target or "")
                prev = uses.get(key)
                if prev is None or (verb == "write" and prev[1] != "write"):
                    uses[key] = (prev[0] if prev else line, verb)
        for e in f.entries:
            fn = by_file_name.get((f.rel, e["fn"])) or resolve(e["fn"], f.rel) if e["fn"] else None
            if fn:
                entries.append({"kind": e["kind"], "label": e["label"], "file": f.rel, "line": e["line"], "fn": fn})
    # `db.cursor().execute("insert into t ...")` is one use of table t, not a second plain use of db.
    named = {(a, s, k) for (a, s, k, t) in uses if t}
    uses = {key: val for key, val in uses.items() if key[3] or (key[0], key[1], key[2]) not in named}
    return {
        "defs": sorted(
            ({"id": d["id"], "file": d["file"], "line": d["line"], "end": d["end"], "doc": d["doc"]} for d in defs),
            key=lambda d: (d["file"], d["line"]),
        )[:3000],
        "calls": [{"from": a, "to": b, "line": ln} for (a, b), ln in sorted(calls.items())],
        "uses": [
            {"fn": a, "name": s, "kind": k, "line": ln, "verb": v, **({"target": t} if t else {})}
            for (a, s, k, t), (ln, v) in sorted(uses.items())
        ],
        "entries": sorted(entries, key=lambda e: (e["file"], e["line"], e["label"])),
    }
