"""What is inside one project, for the map's Inside tab (SPEC 5.21). Imported by map-extract.py.

Reads source files with tree-sitter (no model, no network) and returns plain facts per file; `map_resolve.py`
joins them. A file yields:

  defs     functions and methods: name, class, line, end line, the first line of the docstring or comment
  calls    a call site: a plain name, `this.name`, or `module.name`, with the line (resolved later, never by name alone)
  imports  what the file imports, by local name (resolves a call to the file that defines it)
  entries  what starts work: an HTTP route, a socket, a tool, a timer, a queue consumer, a command
  uses     a function using a known datastore or outside service through its client library, with the line
  tables   table names the file declares (Drizzle, SQLAlchemy and SQLModel, Django, CREATE TABLE in strings)

Frameworks it knows: Python (FastAPI, Flask, Django urls, Celery, APScheduler, schedule, click, typer, MCP) and
JavaScript or TypeScript (Express, Fastify, Hono, Koa, Next.js route files, WebSocket servers, MCP servers,
timers, node-cron, BullMQ, commander). A call site or a library it does not know is left out.
"""

import os

HTTP_VERBS = {"get", "post", "put", "patch", "delete", "head", "options"}
JS_HTTP_VERBS = HTTP_VERBS | {"all"}
READ_WORDS = ("get", "find", "select", "read", "fetch", "list", "query", "scan", "lrange", "hget", "exists", "count", "search", "load", "from")
WRITE_WORDS = ("set", "insert", "add", "save", "write", "put", "push", "lpush", "rpush", "update", "delete", "create", "remove", "enqueue", "send", "publish", "post", "values", "commit", "merge", "upsert", "rm", "mkdir", "rename", "copy", "append", "unlink", "spawn", "exec")
REGISTRY_NAMES = {"commands", "handlers", "registry", "actions", "tools", "routes", "jobs", "operations", "ops", "methods", "procedures", "mutations", "queries"}
DISPATCH_PARAMS = {"name", "command", "cmd", "action", "type", "handler", "op", "method", "tool", "procedure", "event", "job", "task", "rpc"}
REGISTRY_MIN = 8
FETCHY = {"fetch", "fetchFn", "fetchImpl", "fetcher", "doFetch", "httpFetch"}

# Module (exact, or the start of it) -> (display name, kind). Longest match wins. Names match the web page's logo table.
# kind: db (a datastore), orm (a layer over some SQL database, named by the driver or "SQL database").
STORES = {
    "psycopg2": ("Postgres", "db"), "psycopg": ("Postgres", "db"), "asyncpg": ("Postgres", "db"), "pg": ("Postgres", "db"),
    "postgres": ("Postgres", "db"), "pymysql": ("MySQL", "db"), "mysqlclient": ("MySQL", "db"), "mysql2": ("MySQL", "db"),
    "mysql": ("MySQL", "db"), "aiomysql": ("MySQL", "db"),
    "pymongo": ("MongoDB", "db"), "motor": ("MongoDB", "db"), "mongodb": ("MongoDB", "db"), "mongoose": ("MongoDB", "db"),
    "redis": ("Redis", "db"), "aioredis": ("Redis", "db"), "ioredis": ("Redis", "db"), "bullmq": ("Redis", "db"), "bull": ("Redis", "db"),
    "pika": ("RabbitMQ", "db"), "amqplib": ("RabbitMQ", "db"), "kafka": ("Kafka", "db"), "kafkajs": ("Kafka", "db"),
    "confluent_kafka": ("Kafka", "db"), "sqlite3": ("SQLite", "db"), "aiosqlite": ("SQLite", "db"),
    "better-sqlite3": ("SQLite", "db"), "sqlite": ("SQLite", "db"), "@libsql/client": ("SQLite", "db"), "libsql": ("SQLite", "db"),
    "bun:sqlite": ("SQLite", "db"), "node:sqlite": ("SQLite", "db"),
    "@elastic/elasticsearch": ("Elasticsearch", "db"),
    "drizzle-orm/sqlite-core": ("SQLite", "db"), "drizzle-orm/better-sqlite3": ("SQLite", "db"), "drizzle-orm/libsql": ("SQLite", "db"),
    "drizzle-orm/pg-core": ("Postgres", "db"), "drizzle-orm/node-postgres": ("Postgres", "db"), "drizzle-orm/postgres-js": ("Postgres", "db"),
    "drizzle-orm/mysql-core": ("MySQL", "db"), "drizzle-orm/mysql2": ("MySQL", "db"),
    "drizzle-orm": ("SQL database", "orm"), "@prisma/client": ("SQL database", "orm"), "prisma": ("SQL database", "orm"),
    "sqlalchemy": ("SQL database", "orm"), "sqlmodel": ("SQL database", "orm"), "django.db": ("SQL database", "orm"),
    "knex": ("SQL database", "orm"), "typeorm": ("SQL database", "orm"), "sequelize": ("SQL database", "orm"),
    "kysely": ("SQL database", "orm"), "peewee": ("SQL database", "orm"), "tortoise": ("SQL database", "orm"),
}
OUTSIDE = {
    "stripe": "Stripe", "openai": "OpenAI", "anthropic": "Anthropic", "@anthropic-ai/sdk": "Anthropic",
    "sentry_sdk": "Sentry", "@sentry/node": "Sentry", "twilio": "Twilio", "sendgrid": "SendGrid", "@sendgrid/mail": "SendGrid",
    "slack_sdk": "Slack", "@slack/web-api": "Slack", "resend": "Resend", "replicate": "Replicate",
    "telegram": "Telegram", "telebot": "Telegram", "aiogram": "Telegram", "grammy": "Telegram", "telegraf": "Telegram",
    "github": "GitHub", "@octokit/rest": "GitHub", "exa_py": "Exa", "exa-js": "Exa", "firecrawl": "Firecrawl",
    "@mendable/firecrawl-js": "Firecrawl", "firecrawl_py": "Firecrawl", "emails": "Email", "nodemailer": "Email",
    "smtplib": "Email", "boto3": "AWS", "@aws-sdk": "AWS",
    "axios": "Outside service", "got": "Outside service", "ky": "Outside service", "node-fetch": "Outside service",
    "undici": "Outside service", "ofetch": "Outside service", "superagent": "Outside service",
    "requests": "Outside service", "httpx": "Outside service", "aiohttp": "Outside service", "urllib3": "Outside service",
    "fs": "Files", "node:fs": "Files", "shutil": "Files",
    "child_process": "Processes", "node:child_process": "Processes", "subprocess": "Processes",
}
STORE_KEYS = sorted(STORES, key=len, reverse=True)


def service_of(module):
    """(name, kind) of a library, or None. `module` is `a.b.c` or `@scope/pkg/sub`."""
    mod = module.replace("\\", "/")
    for key in STORE_KEYS:
        if mod == key or mod.startswith(key + "/") or mod.startswith(key + "."):
            return STORES[key]
    if module.startswith("@"):
        root = "/".join(module.split("/")[:2])
    else:
        root = module.split("/")[0].split(".")[0]
    if root in OUTSIDE:
        return (OUTSIDE[root], "out")
    if module.startswith("@aws-sdk"):
        return ("AWS", "out")
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


def every_label(ms):
    secs = ms / 1000
    if secs < 1:
        return "many times a second"
    if secs < 120:
        return f"every {int(secs)} seconds"
    if secs < 7200:
        return f"every {int(secs // 60)} minutes"
    return f"every {int(secs // 3600)} hours"


class FileFacts:
    """Facts of one file, collected by `scan_*`."""

    def __init__(self, rel, nlines):
        self.rel = rel
        self.nlines = nlines
        self.fail_lines = set()  # lines inside a catch or except block, or an `if` that ends in a throw or a failed result
        self.defs = []  # {name,cls,line,end,doc}
        self.calls = []  # (line, kind, name, obj, cls)   kind: id | member | this
        self.imports = {}  # local -> (module spec, original name or "*")
        self.reexports = []  # (module spec, names or None for all)
        self.entries = []  # {kind,label,line,fn (name) or None, span (start,end) for an anonymous handler}
        self.uses = []  # (line, service, kind, verb, target, table ident)
        self.tables = []  # table names declared here
        self.table_vars = {}  # identifier -> table name
        self.table_classes = {}  # python class name -> table name
        self.handler_tables = []  # [{keys: [(key, line, ("fn", start, end) | ("id", name))]}]: objects of 3+ handlers by name
        self.injections = []  # (class, property, ("id", name) | ("new", class), line): `new C({ prop: value })`
        self.regs = []  # {name, keys: [(key, line)]}
        self.mounts = []  # (prefix, callee name)
        self.router_prefix = {}  # python router variable -> prefix
        self.modules = set()  # every module this file imports
        self.typed = {}  # name -> set of type names it is declared or built as
        self.client_vars = {}  # variable -> (service, kind): `const prisma = new PrismaClient()`
        self.maybe_uses = []  # (line, imported name, chain after it, first string argument): resolved through the import
        self.implements = {}  # class name -> interface names it declares
        self.props = {}  # class, interface or object type name -> {property: type name}
        self.main_block = False  # python `if __name__ == "__main__"` seen


def has_failure_exit(block):
    """Whether a block throws, raises, or returns a result that says it did not work (`ok: false`)."""
    for n in walk(block):
        if n.type in ("throw_statement", "raise_statement"):
            return True
        if n.type == "return_statement":
            for m in walk(n):
                if m.type == "pair":
                    k, v = m.child_by_field_name("key"), m.child_by_field_name("value")
                    if k is not None and v is not None and text_of(k).strip("'\"") == "ok" and text_of(v) in ("false", "False"):
                        return True
    return False


def mark_failures(facts, order):
    """Lines of the code that only runs when something went wrong: catch and except blocks, and `if` blocks that exit with a failure."""
    for n in order:
        block = None
        if n.type in ("catch_clause", "except_clause"):
            block = n
        elif n.type == "if_statement":
            cons = n.child_by_field_name("consequence")
            if cons is not None and has_failure_exit(cons):
                block = cons
        if block is not None:
            facts.fail_lines.update(range(block.start_point[0] + 1, block.end_point[0] + 2))


def line_of(node):
    return node.start_point[0] + 1


def text_of(node):
    return node.text.decode("utf-8", "replace")


SQL_READ = {"select"}
SQL_WRITE = {"insert", "update", "delete", "replace", "upsert"}


def use_of(svc, method, first_arg):
    """(verb, target) of a call on a client: SQL text names its verb and table; else the method's name decides."""
    if svc[1] == "out":
        return (verb_of(method), None) if svc[0] in ("Files", "Processes") else ("call", None)
    if first_arg:
        words = first_arg.lower().split()
        if words and (words[0] in SQL_READ or words[0] in SQL_WRITE):
            verb = "read" if words[0] in SQL_READ else "write"
            target = None
            for i, w in enumerate(words[:-1]):
                if w in ("into", "from", "table"):
                    target = words[i + 1].strip("`\"'();,").split(".")[-1] or None
                    break
            if words[0] == "update" and len(words) > 1:
                target = words[1].strip("`\"'();,").split(".")[-1] or None
            if target in ("select", "(", "if", "not", "where", "set", "values", "join", "returning"):
                target = None
            return (verb, target)
    return (verb_of(method), None)


def create_tables(raw):
    """Table names a SQL text creates: `create table [if not exists] name`."""
    words = raw.lower().replace("(", " ( ").split()
    out = []
    for i, w in enumerate(words):
        if w == "table" and i > 0 and words[i - 1] in ("create", "temporary", "temp", "virtual"):
            j = i + 1
            if words[j: j + 3] == ["if", "not", "exists"]:
                j += 3
            if j < len(words):
                name = words[j].strip("`\"'[](),;").split(".")[-1]
                if name and name != "(" and name.isidentifier():
                    out.append(name)
    return out


def first_line(raw, limit=90):
    for ln in raw.strip().splitlines():
        ln = ln.strip().lstrip("/*#! ").strip()
        ln = ln[:-2].strip() if ln.endswith("*/") else ln
        if ln and not ln.startswith("@"):
            return ln[:limit]
    return ""


def walk(root):
    stack = [root]
    order = []
    while stack:
        n = stack.pop()
        order.append(n)
        stack.extend(reversed(n.children))
    return order


def snake(name):
    out = ""
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0 and (name[i - 1].islower() or name[i - 1].isdigit()):
            out += "_"
        out += ch.lower()
    return out


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
            return {"kind": "SOCKET", "label": f"WS {first}", "line": line, "fn": fn_name}
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
    if method == "tool" and first is None:
        return {"kind": "TOOL", "label": f"MCP tool {fn_name}", "line": line, "fn": fn_name}
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




def py_chain(node):
    """Names of `a.b.c(...)` from the root: ['a', 'b', 'c'] (a call or subscript in the middle is looked through)."""
    out = []
    while node is not None:
        if node.type == "identifier":
            out.append(text_of(node))
            break
        if node.type == "attribute":
            out.append(text_of(node.child_by_field_name("attribute")))
            node = node.child_by_field_name("object")
        elif node.type == "call":
            node = node.child_by_field_name("function")
        elif node.type in ("subscript", "await", "parenthesized_expression"):
            node = node.named_child(0) if node.named_child_count else None
        else:
            break
    return list(reversed(out))


def py_class_of(node):
    cur = node.parent
    while cur is not None:
        if cur.type == "class_definition":
            return text_of(cur.child_by_field_name("name"))
        if cur.type == "function_definition":
            return None
        cur = cur.parent
    return None


def py_idents(node):
    out = []
    for n in walk(node):
        if n.type == "identifier":
            out.append(text_of(n))
    return out


def py_table_name(cls_node, name):
    body = cls_node.child_by_field_name("body")
    if body is not None:
        for st in body.named_children:
            if st.type == "expression_statement" and st.named_child_count and st.named_child(0).type == "assignment":
                a = st.named_child(0)
                left, right = a.child_by_field_name("left"), a.child_by_field_name("right")
                if left is not None and text_of(left) == "__tablename__":
                    got = py_str(right)
                    if got:
                        return got
    return name.lower()


def scan_python(root, rel, nlines):
    facts = FileFacts(rel, nlines)
    bound = {}  # local name -> (service name, kind)
    order = walk(root)
    # Imports first, in file order.
    for n in order:
        if n.type == "import_statement":
            for c in n.named_children:
                mod = c.child_by_field_name("name") if c.type == "aliased_import" else c
                alias = c.child_by_field_name("alias") if c.type == "aliased_import" else None
                if mod is None:
                    continue
                modtext = text_of(mod)
                facts.modules.add(modtext)
                local = text_of(alias) if alias is not None else modtext.split(".")[0]
                facts.imports[local] = (modtext if alias is not None else modtext.split(".")[0], "*")
                svc = service_of(modtext)
                if svc:
                    bound[local] = svc
        elif n.type == "import_from_statement":
            mod = n.child_by_field_name("module_name")
            modtext = text_of(mod) if mod is not None else ""
            facts.modules.add(modtext)
            svc = service_of(modtext) if modtext else None
            for c in n.named_children:
                if c is mod:
                    continue
                nm = c.child_by_field_name("name") if c.type == "aliased_import" else c
                alias = c.child_by_field_name("alias") if c.type == "aliased_import" else None
                if nm is None or nm.type == "wildcard_import":
                    continue
                orig = text_of(nm)
                local = text_of(alias) if alias is not None else orig
                facts.imports[local] = (modtext, orig)
                if svc:
                    bound[local] = svc
                else:
                    sub = service_of(f"{modtext}.{orig}")
                    if sub:
                        bound[local] = sub
    assigns = {}
    for n in order:
        if n.type == "assignment":
            left, right = n.child_by_field_name("left"), n.child_by_field_name("right")
            if left is None or right is None or left.type != "identifier":
                continue
            assigns[text_of(left)] = right
            if right.type == "call":
                ctor = right.child_by_field_name("function")
                if ctor is not None and ctor.type == "identifier" and text_of(ctor)[:1].isupper():
                    facts.typed.setdefault(text_of(left), set()).add(text_of(ctor))
                root_name = (py_chain(right.child_by_field_name("function")) or [None])[0]
                if root_name in bound:
                    bound[text_of(left)] = bound[root_name]
                fname = py_last(right.child_by_field_name("function"))
                if fname == "APIRouter":
                    prefix = py_str(py_kwargs(right.child_by_field_name("arguments")).get("prefix"))
                    if prefix:
                        facts.router_prefix[text_of(left)] = prefix
            elif right.type in ("subscript", "attribute"):
                if any(i in bound for i in py_idents(right)):
                    bound[text_of(left)] = bound[next(i for i in py_idents(right) if i in bound)]
            # a dict of handlers: NAME = {"key": fn, ...}
            if right.type == "dictionary" and text_of(left).lower() in REGISTRY_NAMES:
                keys = []
                for p in right.named_children:
                    if p.type == "pair":
                        k = py_str(p.child_by_field_name("key"))
                        if k:
                            keys.append((k, line_of(p)))
                if len(keys) >= REGISTRY_MIN:
                    facts.regs.append({"name": text_of(left), "keys": keys})
    # `session: SessionDep`, `db: Session`: a parameter whose type is a datastore client (or an alias of one).
    for n in order:
        if n.type in ("typed_parameter", "typed_default_parameter"):
            ty = n.child_by_field_name("type")
            name = n.child_by_field_name("name")
            if name is None and n.named_child_count:
                name = n.named_child(0)
            if ty is not None and name is not None and name.type == "identifier":
                hit = next((i for i in py_idents(ty) if i in bound), None)
                if hit is not None:
                    bound[text_of(name)] = bound[hit]
                inner = ty.named_child(0) if ty.type == "type" and ty.named_child_count else ty
                if inner is not None and inner.type == "identifier":
                    facts.typed.setdefault(text_of(name), set()).add(text_of(inner))
    for n in order:
        t = n.type
        if t == "class_definition":
            name = text_of(n.child_by_field_name("name"))
            sup = n.child_by_field_name("superclasses")
            sup_text = text_of(sup) if sup is not None else ""
            if "models.Model" in sup_text or "table=True" in sup_text or "Base)" in sup_text and "__tablename__" in text_of(n):
                tbl = py_table_name(n, name)
                facts.table_classes[name] = tbl
                facts.tables.append(tbl)
        elif t == "function_definition":
            name = text_of(n.child_by_field_name("name"))
            facts.defs.append({"name": name, "cls": py_class_of(n), "line": line_of(n), "end": n.end_point[0] + 1, "doc": py_docstring(n)})
        elif t == "decorated_definition":
            definition = n.child_by_field_name("definition")
            if definition is not None and definition.type == "function_definition":
                fname = text_of(definition.child_by_field_name("name"))
                for d in [c for c in n.children if c.type == "decorator"]:
                    got = py_decorator_entry(d, fname, line_of(d))
                    if got:
                        facts.entries.append(got)
        elif t == "if_statement":
            cond = n.child_by_field_name("condition")
            if cond is not None and cond.type == "comparison_operator" and text_of(cond).replace(" ", "").replace("'", '"') in ('__name__=="__main__"', '"__main__"==__name__'):
                facts.main_block = True
        elif t == "string":
            s = text_of(n)
            if len(s) < 4000 and "table" in s.lower():
                facts.tables.extend(create_tables(s))
        elif t == "call":
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
            elif name == "include_router" and pos:
                prefix = py_str(kw.get("prefix"))
                target = py_last(pos[0]) if pos[0].type in ("identifier", "attribute") else None
                obj = text_of(pos[0].child_by_field_name("object")) if pos[0].type == "attribute" and pos[0].child_by_field_name("object").type == "identifier" else None
                if target:
                    facts.mounts.append((prefix or "", target, obj))
            if fn is not None and fn.type == "identifier" and name:
                facts.calls.append((line_of(n), "id", name, None, py_class_of(n)))
            elif fn is not None and fn.type == "attribute":
                obj = fn.child_by_field_name("object")
                attr = text_of(fn.child_by_field_name("attribute"))
                if obj is not None and obj.type == "identifier":
                    on = text_of(obj)
                    facts.calls.append((line_of(n), "this" if on in ("self", "cls") else "member", attr, None if on in ("self", "cls") else on, py_class_of(n)))
            chain = py_chain(fn)
            hit = next((c for c in chain[:-1] if c in bound), None) or (chain[0] if chain and chain[0] in bound and len(chain) > 1 else None)
            if hit is not None:
                svc = bound[hit]
                method = chain[-1]
                verb, target = use_of(svc, method, py_str(pos[0]) if pos else None)
                ident = None
                if pos and target is None:
                    p0 = pos[0]
                    if p0.type == "identifier" and text_of(p0) in assigns and method in ("exec", "execute", "scalars", "scalar"):
                        # `statement = select(User).where(...)`, then `session.exec(statement)`.
                        for c in walk(assigns[text_of(p0)]):
                            if c.type == "call" and py_last(c.child_by_field_name("function")) in ("select", "update", "delete", "insert"):
                                kind_name = py_last(c.child_by_field_name("function"))
                                verb = "read" if kind_name == "select" else "write"
                                inner = py_positional(c.child_by_field_name("arguments"))
                                if inner and inner[0].type == "identifier":
                                    ident = text_of(inner[0])
                                break
                    elif p0.type == "identifier":
                        ident = text_of(p0)
                    elif p0.type == "call" and p0.child_by_field_name("arguments") is not None:
                        inner = py_positional(p0.child_by_field_name("arguments"))
                        if inner and inner[0].type == "identifier":
                            ident = text_of(inner[0])
                            if verb == "use" and py_last(p0.child_by_field_name("function")) == "select":
                                verb = "read"
                if method in ("exec", "execute") and verb == "use":
                    verb = "read" if "select" in text_of(args) else "use"
                facts.uses.append((line_of(n), svc[0], svc[1], verb, target, ident))
    mark_failures(facts, order)
    return facts


# ------------------------------------------------------------------------------------------------
# JavaScript and TypeScript

FN_TYPES = ("arrow_function", "function_expression", "function", "function_declaration", "generator_function")


def js_str(node):
    if node is None:
        return None
    if node.type == "string":
        return "".join(text_of(c) for c in node.children if c.type == "string_fragment")
    if node.type == "template_string":
        # A template with `${...}` keeps its written parts, joined by a space: enough to read `insert into t`.
        return " ".join(text_of(c) for c in node.children if c.type == "string_fragment")
    return None


def js_chain(node):
    """Names of `a.b.c(...)` from the root; `this` is kept as 'this'."""
    out = []
    while node is not None:
        if node.type in ("identifier", "this"):
            out.append(text_of(node))
            break
        if node.type == "member_expression":
            prop = node.child_by_field_name("property")
            out.append(text_of(prop) if prop is not None else "")
            node = node.child_by_field_name("object")
        elif node.type == "call_expression":
            node = node.child_by_field_name("function")
        elif node.type in ("await_expression", "parenthesized_expression", "non_null_expression", "as_expression", "satisfies_expression"):
            node = node.named_child(0) if node.named_child_count else None
        else:
            break
    return list(reversed(out))


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
    if parent is not None and parent.type in ("export_statement", "lexical_declaration"):
        prev = parent.prev_named_sibling
        if prev is not None and prev.type == "comment" and prev.end_point[0] + 1 >= parent.start_point[0]:
            return first_line(text_of(prev))
    return ""


def js_module_of(call):
    args = call.child_by_field_name("arguments")
    return js_str(args.named_child(0)) if args is not None and args.named_child_count else None


def js_class_of(node):
    cur = node.parent
    while cur is not None:
        if cur.type in ("class_declaration", "class", "abstract_class_declaration"):
            nm = cur.child_by_field_name("name")
            return text_of(nm) if nm is not None else None
        cur = cur.parent
    return None


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


def js_number(node, consts):
    if node is None:
        return None
    if node.type == "number":
        try:
            return float(text_of(node).replace("_", ""))
        except ValueError:
            return None
    if node.type == "identifier":
        return js_number(consts.get(text_of(node)), consts)
    if node.type == "binary_expression":
        left, right = js_number(node.child_by_field_name("left"), consts), js_number(node.child_by_field_name("right"), consts)
        op = text_of(node.child_by_field_name("operator"))
        if left is not None and right is not None:
            if op == "*":
                return left * right
            if op == "+":
                return left + right
    if node.type == "parenthesized_expression" and node.named_child_count:
        return js_number(node.named_child(0), consts)
    return None


def js_obj_keys(obj):
    keys = []
    for p in obj.named_children:
        if p.type == "pair":
            k = p.child_by_field_name("key")
            if k is not None:
                keys.append(((js_str(k) or text_of(k)), line_of(p)))
        elif p.type in ("shorthand_property_identifier", "method_definition"):
            nm = p if p.type == "shorthand_property_identifier" else p.child_by_field_name("name")
            if nm is not None:
                keys.append((text_of(nm), line_of(p)))
    return keys


def unwrap(node):
    while node is not None and node.type in ("as_expression", "satisfies_expression", "parenthesized_expression", "non_null_expression") and node.named_child_count:
        node = node.named_child(0)
    return node


def ts_type_name(ann):
    """The one type name a TypeScript annotation names (`T`, `T | undefined`, `Readonly<T>` is not followed), or None."""
    if ann is None:
        return None
    node = ann.named_child(0) if ann.type == "type_annotation" and ann.named_child_count else ann
    if node is None:
        return None
    if node.type == "union_type":
        names = [ts_type_name(c) for c in node.named_children]
        names = [n for n in names if n]
        return names[0] if len(names) == 1 else None
    if node.type == "generic_type":
        node = node.child_by_field_name("name")
    if node is not None and node.type == "type_identifier":
        return text_of(node)
    return None


def scan_js(root, rel, nlines):
    facts = FileFacts(rel, nlines)
    bound = {}
    order = walk(root)
    consts = {}
    for n in order:
        if n.type == "import_statement":
            src = n.child_by_field_name("source")
            spec = js_str(src) or ""
            facts.modules.add(spec)
            svc = service_of(spec) if spec else None
            for c in n.children:
                if c.type != "import_clause":
                    continue
                for d in c.children:
                    if d.type == "identifier":
                        facts.imports[text_of(d)] = (spec, "default")
                        if svc:
                            bound[text_of(d)] = svc
                    elif d.type == "namespace_import" and d.named_child_count:
                        facts.imports[text_of(d.named_child(0))] = (spec, "*")
                        if svc:
                            bound[text_of(d.named_child(0))] = svc
                    elif d.type == "named_imports":
                        for s in d.named_children:
                            orig = s.child_by_field_name("name")
                            alias = s.child_by_field_name("alias")
                            nm = alias or orig
                            if nm is not None and orig is not None:
                                facts.imports[text_of(nm)] = (spec, text_of(orig))
                                if svc:
                                    bound[text_of(nm)] = svc
        elif n.type == "export_statement":
            src = n.child_by_field_name("source")
            if src is not None:
                spec = js_str(src) or ""
                names = []
                star = False
                for c in n.children:
                    if c.type == "*":
                        star = True
                    elif c.type == "export_clause":
                        for s in c.named_children:
                            orig = s.child_by_field_name("name")
                            alias = s.child_by_field_name("alias")
                            if orig is not None:
                                names.append((text_of(alias or orig), text_of(orig)))
                facts.reexports.append((spec, None if star and not names else names))
        elif n.type == "variable_declarator":
            name, value = n.child_by_field_name("name"), n.child_by_field_name("value")
            if name is None or value is None:
                continue
            v = unwrap(value)
            while v is not None and v.type == "await_expression" and v.named_child_count:
                v = unwrap(v.named_child(0))
            if name.type == "identifier" and n.parent is not None and n.parent.parent is not None and n.parent.parent.type == "program" or (n.parent is not None and n.parent.parent is not None and n.parent.parent.type == "export_statement" and name.type == "identifier"):
                consts[text_of(name)] = v
            if v is not None and v.type == "call_expression":
                fn = v.child_by_field_name("function")
                if fn is not None and text_of(fn) == "require":
                    mod = js_module_of(v) or ""
                    facts.modules.add(mod)
                    svc = service_of(mod)
                    if svc and name.type == "identifier":
                        bound[text_of(name)] = svc
                    continue
            if v is not None and v.type == "binary_expression" and text_of(v.child_by_field_name("operator")) in ("||", "??"):
                v = unwrap(v.child_by_field_name("right"))
            if v is not None and v.type == "new_expression" and name.type == "identifier":
                ctor = v.child_by_field_name("constructor")
                if ctor is not None and ctor.type == "identifier":
                    facts.typed.setdefault(text_of(name), set()).add(text_of(ctor))
            if v is not None and v.type in ("call_expression", "new_expression"):
                callee = v.child_by_field_name("function") if v.type == "call_expression" else v.child_by_field_name("constructor")
                chain = js_chain(callee)
                if chain and chain[0] in bound and name.type == "identifier":
                    bound[text_of(name)] = bound[chain[0]]
                    if bound[chain[0]][1] != "out":
                        facts.client_vars[text_of(name)] = bound[chain[0]]
    # `private readonly db: Database.Database`, `db: Pool`: a name whose type is a datastore client.
    for n in order:
        if n.type == "type_annotation":
            owner = n.parent
            if owner is None:
                continue
            nm = owner.child_by_field_name("pattern") or owner.child_by_field_name("name")
            if nm is None or nm.type not in ("identifier", "property_identifier"):
                continue
            tname = ts_type_name(n)
            if tname:
                facts.typed.setdefault(text_of(nm), set()).add(tname)
                # `constructor(private readonly deps: Deps)` and `deps: Deps;` make `deps` a property of the class.
                cur = owner.parent
                if owner.type == "required_parameter" and cur is not None and cur.parent is not None and cur.parent.type == "method_definition":
                    cls = js_class_of(owner)
                    if cls and any(c.type == "accessibility_modifier" or c.type == "readonly" for c in owner.children):
                        facts.props.setdefault(cls, {})[text_of(nm)] = tname
                elif owner.type == "public_field_definition":
                    cls = js_class_of(owner)
                    if cls:
                        facts.props.setdefault(cls, {})[text_of(nm)] = tname
                elif owner.type == "property_signature":
                    holder = owner.parent
                    while holder is not None and holder.type not in ("interface_declaration", "type_alias_declaration"):
                        holder = holder.parent
                    if holder is not None and holder.child_by_field_name("name") is not None:
                        facts.props.setdefault(text_of(holder.child_by_field_name("name")), {})[text_of(nm)] = tname
            for d in walk(n):
                if d.type in ("type_identifier", "identifier") and text_of(d) in bound:
                    bound[text_of(nm)] = bound[text_of(d)]
                    break
    exported = set()
    for n in order:
        t = n.type
        if t == "function_declaration":
            name = n.child_by_field_name("name")
            if name is not None:
                facts.defs.append({"name": text_of(name), "cls": None, "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(n)})
        elif t in ("class_declaration", "abstract_class_declaration"):
            cname = n.child_by_field_name("name")
            if cname is not None:
                for c in n.children:
                    if c.type == "class_heritage":
                        for h in walk(c):
                            if h.type == "implements_clause":
                                for ty in h.named_children:
                                    nm = ts_type_name(ty)
                                    if nm:
                                        facts.implements.setdefault(text_of(cname), []).append(nm)
        elif t == "method_definition":
            name = n.child_by_field_name("name")
            if name is not None:
                facts.defs.append({"name": text_of(name), "cls": js_class_of(n), "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(n)})
        elif t == "public_field_definition":
            name, value = n.child_by_field_name("name"), n.child_by_field_name("value")
            if name is not None and value is not None and value.type in FN_TYPES:
                facts.defs.append({"name": text_of(name), "cls": js_class_of(n), "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(n)})
        elif t == "variable_declarator":
            name, value = n.child_by_field_name("name"), n.child_by_field_name("value")
            value = unwrap(value)
            if name is not None and name.type == "identifier" and value is not None and value.type in FN_TYPES:
                parent = n.parent.parent if n.parent is not None else None
                facts.defs.append({"name": text_of(name), "cls": None, "line": line_of(n), "end": n.end_point[0] + 1, "doc": js_comment_above(parent if parent is not None else n)})
            if name is not None and name.type == "identifier" and value is not None:
                if value.type == "object" and text_of(name).lower() in REGISTRY_NAMES:
                    keys = js_obj_keys(value)
                    if len(keys) >= REGISTRY_MIN:
                        facts.regs.append({"name": text_of(name), "keys": keys})
                if value.type == "call_expression":
                    fname = js_last(value.child_by_field_name("function")) or ""
                    if fname.endswith("Table") and js_module_of(value):
                        facts.table_vars[text_of(name)] = js_module_of(value)
                        facts.tables.append(js_module_of(value))
        elif t == "call_expression":
            fn = n.child_by_field_name("function")
            args = n.child_by_field_name("arguments")
            pos = args.named_children if args is not None else []
            method = js_last(fn)
            first = js_str(pos[0]) if pos else None
            handler = unwrap(pos[-1]) if len(pos) > 1 else None
            if method in JS_HTTP_VERBS and first is not None and first.startswith("/") and handler is not None and fn.type == "member_expression":
                verb = "ANY" if method == "all" else method.upper()
                entry = {"kind": "HTTP", "label": f"{verb} {first}", "line": line_of(n), "fn": None}
                if handler.type in FN_TYPES:
                    entry["fn"] = f"{verb.lower()} {first}"
                    entry["span"] = (line_of(handler), handler.end_point[0] + 1)
                elif handler.type == "call_expression" and (js_last(handler.child_by_field_name("function")) or "") == "upgradeWebSocket":
                    entry["kind"] = "SOCKET"
                    entry["label"] = f"WS {first}"
                    entry["fn"] = f"ws {first}"
                    entry["span"] = (line_of(handler), handler.end_point[0] + 1)
                else:
                    entry["fn"] = js_last(handler)
                facts.entries.append(entry)
            elif method == "route" and len(pos) >= 2 and first is not None and fn.type == "member_expression":
                callee = pos[1]
                nm = js_last(callee.child_by_field_name("function")) if callee.type == "call_expression" else js_last(callee)
                if nm:
                    facts.mounts.append((first, nm, None))
            elif method in ("schedule", "scheduleJob") and first is not None and len(pos) > 1:
                entry = {"kind": "SCHEDULE", "label": humanize_cron(first), "line": line_of(n), "fn": js_last(pos[-1])}
                if pos[-1].type in FN_TYPES:
                    entry["fn"] = f"job {humanize_cron(first)}"
                    entry["span"] = (line_of(pos[-1]), pos[-1].end_point[0] + 1)
                facts.entries.append(entry)
            elif method == "setInterval" and len(pos) > 1:
                ms = js_number(pos[1], consts)
                label = every_label(ms) if ms is not None else "on a timer"
                h = unwrap(pos[0])
                if h.type in FN_TYPES:
                    facts.entries.append({"kind": "SCHEDULE", "label": label, "line": line_of(n), "fn": f"timer {label} (line {line_of(n)})", "span": (line_of(h), h.end_point[0] + 1)})
                elif js_last(h):
                    facts.entries.append({"kind": "SCHEDULE", "label": label, "line": line_of(n), "fn": js_last(h)})
            elif method == "action" and handler is None and pos and js_last(pos[0]) and fn.type == "member_expression":
                inner = fn.child_by_field_name("object")
                if inner is not None and inner.type == "call_expression" and js_last(inner.child_by_field_name("function")) == "command":
                    cargs = inner.child_by_field_name("arguments")
                    label = js_str(cargs.named_child(0)) if cargs is not None and cargs.named_child_count else None
                    if label:
                        facts.entries.append({"kind": "COMMAND", "label": label.split()[0], "line": line_of(n), "fn": js_last(pos[0])})
            elif method == "consume" and first is not None and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "QUEUE", "label": f"consumer {first}", "line": line_of(n), "fn": js_last(pos[1])})
            elif method == "on" and first in ("connection", "upgrade") and len(pos) > 1 and fn.type == "member_expression":
                h = unwrap(pos[-1])
                label = "WebSocket"
                if h.type in FN_TYPES:
                    facts.entries.append({"kind": "SOCKET", "label": label, "line": line_of(n), "fn": f"{label.lower()} (line {line_of(n)})", "span": (line_of(h), h.end_point[0] + 1)})
                elif js_last(h):
                    facts.entries.append({"kind": "SOCKET", "label": label, "line": line_of(n), "fn": js_last(h)})
            elif method in ("tool", "registerTool") and first is not None and len(pos) > 1:
                h = unwrap(pos[-1])
                if h.type in FN_TYPES:
                    facts.entries.append({"kind": "TOOL", "label": f"MCP tool {first}", "line": line_of(n), "fn": f"tool {first}", "span": (line_of(h), h.end_point[0] + 1)})
                elif js_last(h):
                    facts.entries.append({"kind": "TOOL", "label": f"MCP tool {first}", "line": line_of(n), "fn": js_last(h)})
            elif method == "setRequestHandler" and len(pos) > 1 and pos[0].type == "identifier" and text_of(pos[0]) == "CallToolRequestSchema":
                h = unwrap(pos[-1])
                if h.type in FN_TYPES:
                    facts.entries.append({"kind": "TOOL", "label": "MCP tools", "line": line_of(n), "fn": f"mcp tool call (line {line_of(n)})", "span": (line_of(h), h.end_point[0] + 1)})
                elif js_last(h):
                    facts.entries.append({"kind": "TOOL", "label": "MCP tools", "line": line_of(n), "fn": js_last(h)})
            # A call site, to be resolved through the file's imports or its own definitions.
            if fn is not None and fn.type == "identifier":
                facts.calls.append((line_of(n), "id", text_of(fn), None, js_class_of(n)))
            elif fn is not None and fn.type == "member_expression":
                obj = fn.child_by_field_name("object")
                prop = text_of(fn.child_by_field_name("property"))
                if obj is not None and obj.type == "this":
                    facts.calls.append((line_of(n), "this", prop, None, js_class_of(n)))
                elif obj is not None and obj.type == "identifier":
                    facts.calls.append((line_of(n), "member", prop, text_of(obj), js_class_of(n)))
                elif obj is not None and obj.type == "member_expression":
                    chain_names = js_chain(obj)
                    if chain_names and all(c != "" for c in chain_names):
                        facts.calls.append((line_of(n), "chain", prop, tuple(chain_names), js_class_of(n)))
            chain = js_chain(fn)
            if chain and chain[-1] in FETCHY:
                facts.uses.append((line_of(n), "Outside service", "out", "call", None, None))
            elif args is not None and any(
                m.type in ("identifier", "shorthand_property_identifier", "property_identifier") and text_of(m) in FETCHY
                for m in walk(args)
            ):
                # The fetch function is handed to a client library: the call goes out through it.
                facts.uses.append((line_of(n), "Outside service", "out", "call", None, None))
            if len(chain) == 1 and chain[0] in bound and bound[chain[0]][0] in ("Files", "Processes", "Outside service"):
                orig = facts.imports.get(chain[0], (None, chain[0]))[1]
                verb, target = use_of(bound[chain[0]], orig, first)
                facts.uses.append((line_of(n), bound[chain[0]][0], "out", verb, None, None))
            if len(chain) >= 2 and chain[0] in facts.imports and facts.imports[chain[0]][0].startswith((".", "@/", "~/")):
                facts.maybe_uses.append((line_of(n), chain[0], tuple(chain[1:]), first))
            hit = next((c for c in chain[:-1] if c in bound), None)
            if hit is not None and chain:
                svc = bound[hit]
                verb, target = use_of(svc, chain[-1], first)
                ident = None
                if pos and target is None and pos[0].type == "identifier" and chain[-1] in ("from", "into", "insert", "update", "delete", "values"):
                    ident = text_of(pos[0])
                facts.uses.append((line_of(n), svc[0], svc[1], verb, target, ident))
            if method == "describe" or method == "it":
                pass
        elif t == "object":
            keys = []
            for p in n.named_children:
                if p.type != "pair":
                    continue
                k, v = p.child_by_field_name("key"), unwrap(p.child_by_field_name("value"))
                if k is None or v is None or k.type not in ("string", "property_identifier"):
                    continue
                key = js_str(k) if k.type == "string" else text_of(k)
                if not key or " " in key:
                    continue
                if v.type in ("arrow_function", "function_expression", "function"):
                    keys.append((key, line_of(p), ("fn", line_of(v), v.end_point[0] + 1)))
                elif v.type == "identifier":
                    keys.append((key, line_of(p), ("id", text_of(v))))
            if sum(1 for k in keys if k[2][0] == "fn") >= 3:
                facts.handler_tables.append({"keys": keys})
        elif t == "new_expression":
            ctor = n.child_by_field_name("constructor")
            args = n.child_by_field_name("arguments")
            pos = args.named_children if args is not None else []
            name = js_last(ctor) if ctor is not None else None
            if ctor is not None and ctor.type == "identifier" and pos and pos[0].type == "object":
                for p in pos[0].named_children:
                    if p.type == "shorthand_property_identifier":
                        facts.injections.append((text_of(ctor), text_of(p), ("id", text_of(p)), line_of(p)))
                    elif p.type == "pair":
                        k, v = p.child_by_field_name("key"), unwrap(p.child_by_field_name("value"))
                        if k is None or v is None:
                            continue
                        key = js_str(k) if k.type == "string" else text_of(k)
                        if v.type in ("arrow_function", "function_expression", "function"):
                            facts.injections.append((text_of(ctor), key, ("fn", line_of(v), v.end_point[0] + 1), line_of(p)))
                        elif v.type == "object":
                            for sp in v.named_children:
                                if sp.type == "pair":
                                    sk, sv = sp.child_by_field_name("key"), unwrap(sp.child_by_field_name("value"))
                                    if sk is not None and sv is not None and sv.type in ("arrow_function", "function_expression", "function"):
                                        facts.injections.append((text_of(ctor), f"{key}.{js_str(sk) if sk.type == 'string' else text_of(sk)}", ("fn", line_of(sv), sv.end_point[0] + 1), line_of(sp)))
                                elif sp.type == "method_definition" and sp.child_by_field_name("name") is not None:
                                    facts.injections.append((text_of(ctor), f"{key}.{text_of(sp.child_by_field_name('name'))}", ("fn", line_of(sp), sp.end_point[0] + 1), line_of(sp)))
                        elif v.type == "identifier":
                            facts.injections.append((text_of(ctor), key, ("id", text_of(v)), line_of(p)))
                        elif v.type == "new_expression" and v.child_by_field_name("constructor") is not None and v.child_by_field_name("constructor").type == "identifier":
                            facts.injections.append((text_of(ctor), key, ("new", text_of(v.child_by_field_name("constructor"))), line_of(p)))
            if name == "Worker" and pos and js_str(pos[0]) and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "QUEUE", "label": f"consumer {js_str(pos[0])}", "line": line_of(n), "fn": js_last(pos[1])})
            elif name == "Worker" and pos and js_str(pos[0]) and len(pos) > 1 and unwrap(pos[1]).type in FN_TYPES:
                h = unwrap(pos[1])
                facts.entries.append({"kind": "QUEUE", "label": f"consumer {js_str(pos[0])}", "line": line_of(n), "fn": f"worker {js_str(pos[0])}", "span": (line_of(h), h.end_point[0] + 1)})
            elif name == "CronJob" and pos and js_str(pos[0]) and len(pos) > 1 and js_last(pos[1]):
                facts.entries.append({"kind": "SCHEDULE", "label": humanize_cron(js_str(pos[0])), "line": line_of(n), "fn": js_last(pos[1])})
            elif name in ("WebSocketServer", "Server") and ctor is not None and any(m in ("ws", "socket.io") for m in facts.modules):
                pass
            chain = js_chain(ctor)
            if chain and chain[0] in bound:
                svc = bound[chain[0]]
                facts.uses.append((line_of(n), svc[0], svc[1], "call" if svc[1] == "out" else "use", None, None))
        elif t in ("string", "template_string"):
            s = js_str(n)
            if s and len(s) < 6000 and "table" in s.lower():
                facts.tables.extend(create_tables(s))
        elif t == "export_statement":
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
    mark_failures(facts, order)
    return facts
