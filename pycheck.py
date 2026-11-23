"""Runs the real CPython front-end phases on each file and prints one JSON document.

Usage: python pycheck.py <root> <file> [<file> ...]
Phases per file: tokenize -> parse (AST) -> symbol table -> bytecode compile.
Nothing is executed; the program is only compiled.
"""
import ast
import dis
import io
import json
import os
import symtable
import sys
import time
import tokenize
import warnings


def main():
    root = sys.argv[1]
    files = sys.argv[2:]
    diags, trace = [], []
    t0 = time.perf_counter()
    ver = "%d.%d.%d" % sys.version_info[:3]
    success = True

    def now():
        return round((time.perf_counter() - t0) * 1000, 2)

    def add(phase, moment, source, detail, snippet=""):
        step = {"phase": phase, "moment": moment, "source": source, "detail": detail, "t": now()}
        if snippet:
            step["snippet"] = snippet
        trace.append(step)

    def diag(kind, source, line, col, msg):
        diags.append({"kind": kind, "source": source, "line": line or 0, "column": col or 0, "message": msg})

    def syntax_diag(name, e):
        msg = getattr(e, "msg", None) or str(e)
        diag("ERROR", name, getattr(e, "lineno", 0), getattr(e, "offset", 0), "%s: %s" % (type(e).__name__, msg))

    for name in files:
        try:
            with open(os.path.join(root, name), "rb") as fh:
                raw = fh.read()
        except OSError as e:
            diag("ERROR", name, 0, 0, "Cannot read file: %s" % e)
            success = False
            continue

        # 1. Tokenizer
        try:
            toks = list(tokenize.tokenize(io.BytesIO(raw).readline))
            add("TOKENIZE", "FINISHED", name, "%d tokens" % len(toks))
        except Exception:
            # Real syntax problems are reported (with better messages) by the parser below.
            add("TOKENIZE", "FAILED", name, "tokenizer stopped at invalid input")

        # 2. Parser -> AST
        tree = None
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                tree = compile(raw, name, "exec", flags=ast.PyCF_ONLY_AST)
                nodes = sum(1 for _ in ast.walk(tree))
                add("PARSE", "FINISHED", name, "AST with %d nodes" % nodes)
            except (SyntaxError, ValueError, RecursionError, MemoryError) as e:
                success = False
                if isinstance(e, SyntaxError):
                    syntax_diag(name, e)
                    add("PARSE", "FAILED", name, "%s at line %s" % (type(e).__name__, e.lineno))
                else:
                    diag("ERROR", name, 0, 0, "%s: %s" % (type(e).__name__, e))
                    add("PARSE", "FAILED", name, type(e).__name__)
        for w in caught:
            diag("WARNING", name, getattr(w, "lineno", 0), 0, "%s: %s" % (w.category.__name__, w.message))
        if tree is None:
            continue

        # 3. Symbol table (scopes and name binding)
        try:
            table = symtable.symtable(raw.decode("utf-8", "replace"), name, "exec")

            def count(t):
                scopes, names = 1, len(t.get_symbols())
                for c in t.get_children():
                    s, n = count(c)
                    scopes += s
                    names += n
                return scopes, names

            scopes, names = count(table)
            add("SYMTABLE", "FINISHED", name, "%d scope(s), %d name binding(s)" % (scopes, names))
        except Exception as e:
            add("SYMTABLE", "FAILED", name, type(e).__name__)

        # 4. Bytecode compiler
        try:
            with warnings.catch_warnings(record=True) as caught2:
                warnings.simplefilter("always")
                code = compile(tree, name, "exec", dont_inherit=True)
            for w in caught2:
                diag("WARNING", name, getattr(w, "lineno", 0), 0, "%s: %s" % (w.category.__name__, w.message))
            objs, instrs, stack = 0, 0, [code]
            while stack:
                co = stack.pop()
                objs += 1
                instrs += sum(1 for _ in dis.get_instructions(co))
                stack.extend(c for c in co.co_consts if hasattr(c, "co_code"))
            buf = io.StringIO()
            dis.dis(code, file=buf)
            lines = buf.getvalue().rstrip().splitlines()
            snippet = "\n".join(lines[:26]) + ("\n…" if len(lines) > 26 else "")
            add("BYTECODE", "FINISHED", name,
                "%d code object(s), %d bytecode instructions" % (objs, instrs), snippet)
        except SyntaxError as e:
            success = False
            syntax_diag(name, e)
            add("BYTECODE", "FAILED", name, type(e).__name__)
        except Exception as e:
            success = False
            diag("ERROR", name, 0, 0, "%s: %s" % (type(e).__name__, e))
            add("BYTECODE", "FAILED", name, type(e).__name__)

    result = {"success": success and not any(d["kind"] == "ERROR" for d in diags),
              "pythonVersion": ver, "totalMs": now(), "diagnostics": diags, "trace": trace}
    sys.stdout.buffer.write(json.dumps(result).encode("ascii"))


if __name__ == "__main__":
    main()
