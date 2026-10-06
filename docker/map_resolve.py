"""Joins the per-file facts of `map_inside.py` into one project's Inside facts (SPEC 5.21).

A call becomes an edge only when it can be proved from the code: the callee is defined in the same file, or
the file imports it (a relative path, a workspace package, a dotted Python module). A method called on an
object (`service.now()`) is never matched by name, so no edge is guessed. Each edge says how it was proved
(`same-file` or `import`), and the server follows nothing else.

It also reads the project's manifests (package.json, pyproject.toml, requirements, Prisma schemas, .sql files)
for datastores and tables, and keeps only the functions an entry point can reach, so the facts stay small.
"""

import json
import os

import map_inside as mi

SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target", "coverage", ".turbo", ".cache", "vendor"}
JS_EXTS = (".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs")
SCRIPT_EXTS = (".ts", ".mts", ".js", ".mjs", ".cjs", ".py", ".tsx")
REACH_DEPTH = 6
SKIP_SCRIPTS = {"build", "postinstall", "preinstall", "prepare", "typecheck", "test", "lint", "format", "check", "clean", "prebuild", "postbuild"}
MAX_MEMBERS = 400


# ------------------------------------------------------------------------------------------------
# Manifests


def collect_meta(src):
    """Package manifests, dependency names, Prisma models and SQL tables found under a project folder."""
    meta = {"packages": {}, "deps": set(), "pyproject": [], "prisma": [], "sql_tables": []}
    seen = 0
    for base, dirs, names in os.walk(src):
        rel_base = os.path.relpath(base, src)
        depth = 0 if rel_base == "." else rel_base.count(os.sep) + 1
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")] if depth < 7 else []
        for name in names:
            low = name.lower()
            path = os.path.join(base, name)
            rel = os.path.normpath(os.path.relpath(path, src)).replace(os.sep, "/")
            try:
                if os.path.islink(path) or os.path.getsize(path) > 300_000:
                    continue
            except OSError:
                continue
            if low == "package.json":
                try:
                    data = json.load(open(path, encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict):
                    meta["packages"][os.path.dirname(rel)] = data
                    for key in ("dependencies", "devDependencies", "optionalDependencies"):
                        if isinstance(data.get(key), dict):
                            meta["deps"].update(data[key].keys())
            elif low == "pyproject.toml":
                try:
                    import tomllib

                    data = tomllib.loads(open(path, encoding="utf-8").read())
                except Exception:
                    continue
                meta["pyproject"].append((os.path.dirname(rel), data))
                proj = data.get("project", {}) if isinstance(data.get("project"), dict) else {}
                for d in proj.get("dependencies", []) or []:
                    meta["deps"].add(dep_name(str(d)))
                tool = data.get("tool", {}) if isinstance(data.get("tool"), dict) else {}
                poetry = tool.get("poetry", {}) if isinstance(tool.get("poetry"), dict) else {}
                if isinstance(poetry.get("dependencies"), dict):
                    meta["deps"].update(poetry["dependencies"].keys())
            elif low.startswith("requirements") and low.endswith(".txt"):
                try:
                    for ln in open(path, encoding="utf-8").read().splitlines():
                        ln = ln.strip()
                        if ln and not ln.startswith(("#", "-")):
                            meta["deps"].add(dep_name(ln))
                except OSError:
                    continue
            elif low.endswith(".prisma"):
                try:
                    meta["prisma"].append(open(path, encoding="utf-8").read())
                except OSError:
                    continue
            elif low.endswith(".sql") and seen < 200:
                seen += 1
                try:
                    meta["sql_tables"].extend(mi.create_tables(open(path, encoding="utf-8", errors="replace").read()))
                except OSError:
                    continue
    return meta


def dep_name(spec):
    out = ""
    for ch in spec.strip():
        if ch.isalnum() or ch in "-_.@/":
            out += ch
        else:
            break
    return out.lower().replace("_", "-") if not out.startswith("@") else out


def prisma_facts(texts):
    """(provider names, model names) from Prisma schemas."""
    providers, models = [], []
    mapping = {"postgresql": "Postgres", "postgres": "Postgres", "mysql": "MySQL", "sqlite": "SQLite", "mongodb": "MongoDB"}
    for text in texts:
        in_ds = False
        for raw in text.splitlines():
            words = raw.strip().split()
            if len(words) >= 2 and words[0] == "datasource":
                in_ds = True
            elif in_ds and words[:1] == ["provider"] and "=" in raw:
                val = raw.split("=", 1)[1].strip().strip('"').strip("'")
                providers.append(mapping.get(val, val))
                in_ds = False
            elif len(words) >= 2 and words[0] == "model":
                models.append(words[1])
    return providers, models


def stores_of(files, meta):
    """Datastores the project declares or imports: [{name, kind, via, tables}]."""
    found = {}
    used_names = set(meta["deps"])
    for f in files:
        used_names.update(f.modules)
    for name in sorted(used_names):
        svc = mi.service_of(name) if name else None
        if svc is None or svc[1] == "out":
            continue
        base = name.split("/")[0] if not name.startswith("@") else "/".join(name.split("/")[:2])
        found.setdefault(svc[0], {"kind": svc[1], "via": set()})["via"].add(base)
    providers, models = prisma_facts(meta["prisma"])
    for p in providers:
        found.setdefault(p, {"kind": "db", "via": set()})["via"].add("prisma")
    sql = {n for n, v in found.items() if v["kind"] == "db" and n in ("Postgres", "MySQL", "SQLite")}
    if sql:
        found.pop("SQL database", None)
    elif "SQL database" in found:
        found["SQL database"]["kind"] = "db"
    tables = []
    for f in files:
        tables.extend(f.tables)
    tables.extend(models)
    tables.extend(meta["sql_tables"])
    tables = sorted({t for t in tables if t and len(t) >= 3})
    imported = {}
    for f in files:
        for m in f.modules:
            svc = mi.service_of(m) if m else None
            if svc and svc[1] != "out":
                imported[svc[0]] = imported.get(svc[0], 0) + 1
    # The driver or database a project's tables live in: the one SQL store it has.
    sqlish = sorted((n for n in found if n in ("Postgres", "MySQL", "SQLite", "SQL database")), key=lambda n: (-imported.get(n, 0), n))
    out = []
    for name in sorted(found, key=lambda n: (n != (sqlish[0] if sqlish else None), n)):
        entry = {"name": name, "kind": "db", "via": sorted(found[name]["via"])[:6]}
        if name == (sqlish[0] if sqlish else None) and tables:
            entry["tables"] = tables[:60]
        out.append(entry)
    return out


# ------------------------------------------------------------------------------------------------
# Resolving a module to a file


class Modules:
    def __init__(self, files, meta):
        self.files = files
        self.by_suffix = {}
        for rel in files:
            if rel.endswith(".py"):
                parts = rel[:-3].split("/")
                if parts[-1] == "__init__":
                    parts = parts[:-1]
                for i in range(len(parts)):
                    self.by_suffix.setdefault(".".join(parts[i:]), []).append(rel)
        self.packages = {}
        for d, data in meta["packages"].items():
            nm = data.get("name")
            if isinstance(nm, str):
                self.packages[nm] = d

    def js_candidates(self, base):
        stem, ext = os.path.splitext(base)
        bases = [base]
        if ext in (".js", ".mjs", ".cjs", ".jsx"):
            bases = [stem + e for e in (".ts", ".tsx", ".mts", ".js")] + [base]
        out = list(bases)
        out += [base + e for e in JS_EXTS]
        out += [f"{base}/index{e}" for e in JS_EXTS]
        return out

    def resolve_js(self, from_rel, spec):
        if spec.startswith("."):
            base = os.path.normpath(os.path.join(os.path.dirname(from_rel), spec)).replace(os.sep, "/")
        elif spec.startswith(("@/", "~/")):
            parts = from_rel.split("/")
            if "src" not in parts:
                return None
            idx = len(parts) - 1 - parts[::-1].index("src")
            base = "/".join(parts[: idx + 1] + [spec[2:]])
        else:
            base = None
            for name, d in self.packages.items():
                if spec == name:
                    for c in (f"{d}/src/index", f"{d}/index", f"{d}/src/main"):
                        for cand in self.js_candidates(c):
                            if cand in self.files:
                                return cand
                if spec.startswith(name + "/"):
                    sub = spec[len(name) + 1:]
                    for root in (f"{d}/src/{sub}", f"{d}/{sub}"):
                        for cand in self.js_candidates(root):
                            if cand in self.files:
                                return cand
            return None
        for cand in self.js_candidates(base):
            if cand in self.files:
                return cand
        return None

    def resolve_py(self, from_rel, mod):
        if mod.startswith("."):
            level = len(mod) - len(mod.lstrip("."))
            rest = mod.lstrip(".")
            base = os.path.dirname(from_rel)
            for _ in range(level - 1):
                base = os.path.dirname(base)
            path = os.path.join(base, *rest.split(".")) if rest else base
            path = path.replace(os.sep, "/")
            for cand in (f"{path}.py", f"{path}/__init__.py"):
                if cand in self.files:
                    return cand
            return None
        cands = self.by_suffix.get(mod)
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]
        here = from_rel.split("/")

        def shared(c):
            n = 0
            for a, b in zip(here, c.split("/")):
                if a != b:
                    break
                n += 1
            return n

        return max(cands, key=shared)

    def resolve(self, from_rel, spec):
        if from_rel.endswith(".py"):
            return self.resolve_py(from_rel, spec)
        return self.resolve_js(from_rel, spec)


# ------------------------------------------------------------------------------------------------
# One project


def assemble(per_file, meta):
    files = {f.rel: f for f in per_file}
    mods = Modules(files, meta)

    # Function ids: the qualified name when it is unique in the project, else with the file's name in front.
    raw = []
    for f in per_file:
        for d in f.defs:
            raw.append((f, d, f"{d['cls']}.{d['name']}" if d["cls"] else d["name"]))
    counts = {}
    for _f, _d, q in raw:
        counts[q] = counts.get(q, 0) + 1
    defs = []  # {id, file, line, end, doc}
    top = {}  # (file, name) -> id (functions, not methods)
    meth = {}  # (file, cls, name) -> id
    used_ids = set()

    def make_id(f, q, line):
        stem = os.path.splitext(os.path.basename(f.rel))[0]
        fid = q if counts.get(q, 1) == 1 and q not in used_ids else f"{stem}.{q}"
        if fid in used_ids:
            fid = f"{stem}.{q}:{line}"
        used_ids.add(fid)
        return fid

    for f, d, q in raw:
        fid = make_id(f, q, d["line"])
        defs.append({"id": fid, "file": f.rel, "line": d["line"], "end": d["end"], "doc": d["doc"]})
        if d["cls"]:
            meth[(f.rel, d["cls"], d["name"])] = fid
        else:
            top.setdefault((f.rel, d["name"]), fid)
    synthetic = {}  # (file, fn name) -> id

    def add_synthetic(f, name, start, end):
        key = (f.rel, name)
        if key in synthetic:
            return synthetic[key]
        fid = make_id(f, name, start)
        defs.append({"id": fid, "file": f.rel, "line": start, "end": end, "doc": ""})
        synthetic[key] = fid
        top.setdefault((f.rel, name), fid)
        return fid

    for f in per_file:
        for e in f.entries:
            if "span" in e:
                add_synthetic(f, e["fn"], e["span"][0], e["span"][1])

    def find_def(rel, name, depth=0):
        got = top.get((rel, name))
        if got:
            return got
        if depth >= 3 or rel not in files:
            return None
        tf = files[rel]
        for spec, names in tf.reexports:
            target = mods.resolve(rel, spec)
            if target is None:
                continue
            if names is None:
                got = find_def(target, name, depth + 1)
            else:
                orig = next((o for a, o in names if a == name), None)
                got = find_def(target, orig, depth + 1) if orig else None
            if got:
                return got
        if rel.endswith(".py") and name in tf.imports:
            spec, orig = tf.imports[name]
            target = mods.resolve(rel, spec)
            if target and orig != "*":
                return find_def(target, orig, depth + 1)
        return None

    implementers = {}
    for f in per_file:
        for cname, ifaces in f.implements.items():
            for i in ifaces:
                implementers.setdefault(i, []).append((f.rel, cname))

    def method_of(cur, name):
        """The method a call reaches on a value of type `cur`: the class's own, or the one class that declares `implements`."""
        got = meth.get((cur[0], cur[1], name))
        if got:
            return got
        impls = [m for m in (meth.get((rel, c, name)) for rel, c in implementers.get(cur[1], [])) if m]
        return impls[0] if len(impls) == 1 else None

    classes = {(r, c) for (r, c, _n) in meth}
    for f in per_file:
        for cname in f.props:
            classes.add((f.rel, cname))

    def find_type_file(rel, cname, depth=0):
        return find_class_file(rel, cname, depth)

    def find_class_file(rel, cname, depth=0):
        """The file that defines class `cname`, seen from file `rel`: its own, an import's, or a re-export's."""
        if (rel, cname) in classes:
            return rel
        if depth >= 3 or rel not in files:
            return None
        tf = files[rel]
        if cname in tf.imports:
            spec, orig = tf.imports[cname]
            target = mods.resolve(rel, spec)
            if target and orig not in ("*",):
                return find_class_file(target, cname if orig == "default" else orig, depth + 1)
        for spec, names in tf.reexports:
            target = mods.resolve(rel, spec)
            if target is None:
                continue
            want = cname if names is None else next((o for a, o in names if a == cname), None)
            if want:
                got = find_class_file(target, want, depth + 1)
                if got:
                    return got
        return None

    def resolve_name(f, name, cls=None):
        """(id, how) of a plain name used in file f, or None."""
        got = top.get((f.rel, name))
        if got:
            return got, "same-file"
        if name in f.imports:
            spec, orig = f.imports[name]
            target = mods.resolve(f.rel, spec)
            if target:
                want = name if orig in ("default", "*") else orig
                got = find_def(target, want)
                if got:
                    return got, "import"
        return None

    def resolve_call(f, kind, name, obj, cls):
        if kind == "this":
            got = meth.get((f.rel, cls, name)) if cls else None
            return (got, "same-file") if got else None
        if kind == "id":
            return resolve_name(f, name, cls)
        if kind == "chain":
            names = list(obj)
            if names[0] == "this":
                cur = (f.rel, cls) if cls else None
                rest = names[1:]
            elif names[0] in f.typed and names[0] not in f.imports and len(f.typed[names[0]]) == 1:
                cname = next(iter(f.typed[names[0]]))
                cfile = find_type_file(f.rel, cname)
                cur = (cfile, cname) if cfile else None
                rest = names[1:]
            else:
                return None
            for prop in rest:
                if cur is None:
                    return None
                nxt = files[cur[0]].props.get(cur[1], {}).get(prop)
                nfile = find_type_file(cur[0], nxt) if nxt else None
                cur = (nfile, nxt) if nfile else None
            if cur is None:
                return None
            got = method_of(cur, name)
            return (got, "import" if cur[0] != f.rel else "same-file") if got else None
        if kind == "member" and obj in f.typed and obj not in f.imports and len(f.typed[obj]) == 1:
            cname = next(iter(f.typed[obj]))
            cfile = find_class_file(f.rel, cname)
            got = method_of((cfile, cname), name) if cfile else None
            return (got, "import" if cfile != f.rel else "same-file") if got else None
        if kind == "member" and obj in f.imports:
            spec, orig = f.imports[obj]
            target = mods.resolve(f.rel, spec) if orig in ("default", "*") else None
            if target is None and orig not in ("default", "*"):
                sub = mods.resolve(f.rel, f"{spec}.{orig}" if not spec.endswith(".") else f"{spec}{orig}")
                target = sub
            if target:
                got = find_def(target, name)
                if got:
                    return got, "import"
        return None

    in_file = {}
    for d in defs:
        in_file.setdefault(d["file"], []).append(d)

    def enclosing(rel, line):
        best = None
        for d in in_file.get(rel, []):
            if d["line"] <= line <= d["end"] and (best is None or (d["end"] - d["line"]) < (best["end"] - best["line"])):
                best = d
        return best["id"] if best else None

    # Scripts: a package's bin and scripts, a Python file run as __main__, pyproject scripts.
    script_entries = []

    def add_script(rel, label, line=1):
        f = files.get(rel)
        if f is None:
            return
        stem = os.path.splitext(os.path.basename(rel))[0]
        fid = add_synthetic(f, f"{stem} (script)", 1, max(f.nlines, 1))
        script_entries.append((f, {"kind": "COMMAND", "label": label, "line": line, "fn": f"{stem} (script)"}, fid))

    for d, data in meta["packages"].items():
        pname = data.get("name") if isinstance(data.get("name"), str) else (d or ".")
        bins = data.get("bin")
        if isinstance(bins, str):
            bins = {pname: bins}
        for bname, bpath in (bins or {}).items() if isinstance(bins, dict) else []:
            rel = os.path.normpath(os.path.join(d, str(bpath))).replace(os.sep, "/")
            for cand in mods.js_candidates(rel):
                if cand in files:
                    add_script(cand, f"{bname} (command line)")
                    break
        scripts = data.get("scripts")
        for sname, cmd in (scripts or {}).items() if isinstance(scripts, dict) else []:
            if sname in SKIP_SCRIPTS:
                continue
            for tok in str(cmd).split():
                tok = tok.strip("\"'")
                if tok.endswith(SCRIPT_EXTS):
                    rel = os.path.normpath(os.path.join(d, tok)).replace(os.sep, "/")
                    if rel in files:
                        if not any(e[0].rel == rel for e in script_entries):
                            add_script(rel, f"npm run {sname}")
                        break
    for d, data in meta["pyproject"]:
        proj = data.get("project", {}) if isinstance(data.get("project"), dict) else {}
        scripts = proj.get("scripts", {}) if isinstance(proj.get("scripts"), dict) else {}
        for sname, target in scripts.items():
            modname, _, fn = str(target).partition(":")
            for rel in mods.by_suffix.get(modname, []):
                if fn and (rel, fn) in top:
                    script_entries.append((files[rel], {"kind": "COMMAND", "label": f"{sname} (command line)", "line": 1, "fn": fn}, top[(rel, fn)]))
                    break
    for f in per_file:
        if f.main_block and f.rel.endswith(".py") and not any(p in ("tests", "test", "alembic", "migrations") for p in f.rel.split("/")):
            add_script(f.rel, f"python {f.rel}")

    # Calls: only those proved by the file's own definitions or its imports.
    calls = {}
    for f in per_file:
        for line, kind, name, obj, cls in f.calls:
            src_id = enclosing(f.rel, line)
            got = resolve_call(f, kind, name, obj, cls)
            if src_id and got and got[0] != src_id:
                calls.setdefault((src_id, got[0]), (line, got[1]))

    # Entries, with the prefix of a router the file is mounted under.
    mount_prefix = {}
    mounted = []
    for f in per_file:
        for prefix, name, obj in f.mounts:
            target = None
            if obj and obj in f.imports:
                spec, orig = f.imports[obj]
                target = mods.resolve(f.rel, spec) if orig in ("default", "*") else mods.resolve(f.rel, f"{spec}.{orig}")
            if target is None and name in f.imports:
                spec, orig = f.imports[name]
                target = mods.resolve(f.rel, spec)
            if target and target != f.rel:
                mounted.append((f.rel, prefix, target))

    def prefix_of(rel, depth=0):
        if depth > 4:
            return ""
        for src_rel, prefix, target in mounted:
            if target == rel:
                return join_path(prefix_of(src_rel, depth + 1), prefix)
        return ""

    def join_path(a, b):
        if not a:
            return b
        if not b or b == "/":
            return a
        return a.rstrip("/") + "/" + b.lstrip("/")

    regs = [r for f in per_file for r in ({"file": f.rel, **x} for x in f.regs)]
    regs.sort(key=lambda r: -len(r["keys"]))
    entries = []
    for f in per_file:
        local_prefix = next(iter(f.router_prefix.values()), "") if len(set(f.router_prefix.values())) == 1 else ""
        base = prefix_of(f.rel)
        client = "react" in f.modules or "react-dom" in f.modules or "vue" in f.modules or "svelte" in f.modules
        for e in f.entries:
            if client and e["kind"] in ("SCHEDULE", "TOOL", "SOCKET"):
                continue
            fn = None
            if "span" in e:
                fn = synthetic.get((f.rel, e["fn"]))
            else:
                got = resolve_name(f, e["fn"]) if e["fn"] else None
                fn = got[0] if got else meth_by_name(meth, f.rel, e["fn"])
            if not fn:
                continue
            label = e["label"]
            if e["kind"] in ("HTTP", "SOCKET") and " " in label:
                verb, path = label.split(" ", 1)
                path = join_path(join_path(base, local_prefix), path)
                label = f"{verb} {path}"
            item = {"kind": e["kind"], "label": label, "file": f.rel, "line": e["line"], "fn": fn}
            if e["kind"] == "HTTP" and regs and dispatcher_param(label):
                reg = regs[0]
                item["members"] = [{"label": k, "file": reg["file"], "line": ln} for k, ln in reg["keys"][:MAX_MEMBERS]]
                item["count"] = len(reg["keys"])
            entries.append(item)
    for f, e, fid in script_entries:
        entries.append({"kind": e["kind"], "label": e["label"], "file": f.rel, "line": e["line"], "fn": fid})

    # Uses of a datastore or outside service, with the table a name stands for.
    table_names = {}
    for f in per_file:
        table_names.update(f.table_vars)
        table_names.update(f.table_classes)
    stores = stores_of(per_file, meta)
    _providers, prisma_models = prisma_facts(meta["prisma"])
    models = {m.lower(): m for m in prisma_models}
    pending_uses = []
    for f in per_file:
        for line, root, chain, first in f.maybe_uses:
            spec, orig = f.imports[root]
            target = mods.resolve(f.rel, spec)
            tf = files.get(target) if target else None
            if tf is None or not tf.client_vars:
                continue
            var = orig if orig in tf.client_vars else (next(iter(tf.client_vars)) if orig == "default" and len(tf.client_vars) == 1 else None)
            if var is None:
                continue
            svc = tf.client_vars[var]
            prisma = any(m.startswith("@prisma/client") for m in tf.modules)
            table = models.get(chain[0].lower(), chain[0]) if prisma and len(chain) >= 2 else None
            verb, tgt = mi.use_of(svc, chain[-1], first)
            pending_uses.append((f, line, svc[0], svc[1], verb, tgt or table))
    sql_names = [s["name"] for s in stores if s["name"] in ("Postgres", "MySQL", "SQLite")][:1]
    uses = {}
    all_uses = [(f, *u) for f in per_file for u in f.uses] + [(f, line, svc, kind, verb, tgt, None) for f, line, svc, kind, verb, tgt in pending_uses]
    for f, line, svc, kind, verb, target, ident in all_uses:
        if True:
            src_id = enclosing(f.rel, line)
            if not src_id:
                continue
            if kind == "orm":
                kind = "db"
            if svc == "SQL database" and len(sql_names) == 1:
                svc = sql_names[0]
            if target is None and ident is not None:
                target = table_names.get(ident)
            key = (src_id, svc, kind, target or "")
            prev = uses.get(key)
            if prev is None or (verb == "write" and prev[1] != "write"):
                uses[key] = (prev[0] if prev else line, verb)
    # `db.cursor().execute("insert into t ...")` is one use of table t, not a second plain use of db.
    named = {(a, s, k) for (a, s, k, t) in uses if t}
    uses = {key: val for key, val in uses.items() if key[3] or (key[0], key[1], key[2]) not in named}

    # Keep only what an entry point can reach.
    out_calls = {}
    for (a, b), (ln, how) in calls.items():
        out_calls.setdefault(a, []).append((b, ln, how))
    seen = {}
    frontier = [e["fn"] for e in entries]
    for fid in frontier:
        seen[fid] = 0
    while frontier:
        nxt = []
        for fid in frontier:
            if seen[fid] >= REACH_DEPTH:
                continue
            for b, _ln, _how in out_calls.get(fid, []):
                if b not in seen:
                    seen[b] = seen[fid] + 1
                    nxt.append(b)
        frontier = nxt
    keep = set(seen)
    kept_defs = [d for d in defs if d["id"] in keep]
    return {
        "defs": sorted(kept_defs, key=lambda d: (d["file"], d["line"])),
        "calls": [
            {"from": a, "to": b, "line": ln, "how": how}
            for (a, b), (ln, how) in sorted(calls.items())
            if a in keep and b in keep
        ],
        "uses": [
            {"fn": a, "name": s, "kind": k, "line": ln, "verb": v, **({"target": t} if t else {})}
            for (a, s, k, t), (ln, v) in sorted(uses.items())
            if a in keep
        ],
        "entries": sorted(entries, key=lambda e: (e["file"], e["line"], e["label"]))[:2000],
        "stores": stores,
    }


def meth_by_name(meth, rel, name):
    for (r, _cls, n), fid in meth.items():
        if r == rel and n == name:
            return fid
    return None


def dispatcher_param(label):
    path = label.split(" ", 1)[1] if " " in label else label
    segs = [s for s in path.split("/") if s]
    params = [s for s in segs if s.startswith((":", "{", "<"))]
    if len(params) != 1 or segs[-1] != params[0]:
        return False
    for seg in params:
        name = None
        if seg.startswith(":"):
            name = seg[1:]
        elif seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1].split(":")[0]
        elif seg.startswith("<") and seg.endswith(">"):
            name = seg[1:-1].split(":")[-1]
        if name and name.lower() in mi.DISPATCH_PARAMS:
            return True
    return False
