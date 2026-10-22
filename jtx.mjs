import { posix as path } from "node:path";
import { existsSync } from "node:fs";
import {
  resolve as osResolve,
  dirname as osDirname,
  join as osJoin,
} from "node:path";
import { builtinModules } from "node:module";

const NOT_DECL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "else",
  "do",
  "try",
  "with",
]);

const USE_COMPLETE = /^use\s+(?:[\s\S]*?\s+from\s+)?(["'])[^"'\n]+\1\s*;?\s*$/;

const DECL = /^(\s*)(default\s+)?([A-Za-z_$][\w$]*)(\s*\([^)]*\)[^{;=]*\{\s*)$/;

const VAR_DECL =
  /^(export\s+)?(?:async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function convertUse(stmt) {
  let s = stmt.replace(/^use\s+/, "import ").trimEnd();
  if (!s.endsWith(";")) s += ";";
  return s;
}

function scanLine(line, st, kind = "brace") {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (st.block) {
      if (c === "*" && n === "/") {
        st.block = false;
        i++;
      }
      continue;
    }
    if (st.tpl) {
      if (c === "\\") i++;
      else if (c === "`") st.tpl = false;
      continue;
    }
    if (c === "/" && n === "*") {
      st.block = true;
      i++;
      continue;
    }
    if (c === "/" && n === "/") break;
    if (c === "`") {
      st.tpl = true;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      i = j;
      continue;
    }
    if (
      (kind !== "paren" && c === "{") ||
      (kind !== "brace" && (c === "(" || c === "["))
    )
      delta++;
    else if (
      (kind !== "paren" && c === "}") ||
      (kind !== "brace" && (c === ")" || c === "]"))
    )
      delta--;
  }
  return delta;
}

function dedent(body) {
  const indents = body
    .filter((l) => l.trim())
    .map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return body.map((l) => l.slice(min));
}

function normalizePath(p) {
  const n = path.normalize(p);
  if (path.isAbsolute(n) || n === ".." || n.startsWith("../")) {
    throw new Error(`invalid path (outside the project folder): ${p}`);
  }
  return n;
}

function parseDecorators(line, warnings) {
  const out = {};
  for (const part of line.trim().split("&&")) {
    const m = /^@([\w-]+)(?:\s*=\s*(["'])(.*?)\2)?$/.exec(part.trim());
    if (!m) {
      warnings.push(`invalid decorator: ${part.trim()}`);
      continue;
    }
    if (m[1] === "no-export") out.noExport = true;
    else if (m[1] === "path") {
      if (m[3] === undefined)
        warnings.push('@path needs a value: @path="folder/File.jsx"');
      else out.path = normalizePath(m[3]);
    } else warnings.push(`unknown decorator: @${m[1]}`);
  }
  return out;
}

function declaredNames(lines) {
  const r = [];
  lines.forEach((l, line) => {
    const m = VAR_DECL.exec(l);
    if (m) r.push({ name: m[2], line, exported: !!m[1] });
  });
  return r;
}

function stripParamTypes(params) {
  let out = "";
  let depth = 0;
  let angle = 0;
  let inType = false;
  let inDefault = false;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < params.length && params[j] !== c) {
        if (params[j] === "\\") j++;
        j++;
      }
      if (!inType) out += params.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;

    if (inType) {
      if (c === "<") angle++;
      else if (c === ">" && params[i - 1] !== "=") angle--;
      else if (depth === 0 && angle === 0 && c === ",") {
        inType = false;
        inDefault = false;
        out += c;
      } else if (
        depth === 0 &&
        angle === 0 &&
        c === "=" &&
        params[i + 1] !== ">"
      ) {
        inType = false;
        inDefault = true;
        out += " =";
      }
      continue;
    }
    if (depth === 0 && c === ",") inDefault = false;
    if (depth === 0 && !inDefault && c === ":") {
      inType = true;
      angle = 0;
      out = out.replace(/\??\s*$/, "");
      continue;
    }
    if (
      depth === 0 &&
      c === "=" &&
      params[i + 1] !== ">" &&
      params[i - 1] !== "="
    )
      inDefault = true;
    out += c;
  }
  return out.trimEnd();
}

function stripHeaderTypes(rest) {
  const m = /^(\s*\()([^)]*)(\))([\s\S]*)$/.exec(rest);
  if (!m) return rest;
  const tail = m[4].replace(/^\s*:[^{]*?(?=\s*\{\s*$)/, "");
  return m[1] + stripParamTypes(m[2]) + m[3] + tail;
}

const HOOK_HEAD =
  /^(\s*)(state|ref|id|deferred|context)\s+([A-Za-z_$][\w$]*)(.*)$/;

const setterName = (name) => "set" + name[0].toUpperCase() + name.slice(1);

function balance(text) {
  const st = { block: false, tpl: false };
  return text.split("\n").reduce((n, l) => n + scanLine(l, st, "all"), 0);
}

function commentIndex(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

function hookLike(line) {
  const m = HOOK_HEAD.exec(line);
  return m && /^\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?(?::|=(?!>))/.test(m[4])
    ? m
    : null;
}

const hookError = (i, line, msg) =>
  new Error(`line ${i + 1}: "${line.trim()}" ${msg}`);
const MSG_SETTER =
  "only state accepts a setter name (state count, setCount = 0)";
const MSG_NESTED =
  "hooks only work at the top level of a function (not inside if, for, or inner functions)";
const MSG_TOP =
  "is only translated inside functions (components); write the full hook here, e.g. const [x, setX] = useState(...)";

const MSG_SHARE_SCOPE =
  "declares shared state and must be at the top level of a file, outside functions and <variables>";
const MSG_SHARE_INIT = "needs an initial value, e.g. share cart = []";
const MSG_SHARE_BAD =
  "is not a valid share declaration, expected: share name = value";

const SHARE_HEAD = /^\s*share\s+([A-Za-z_$][\w$]*)(.*)$/;

function shareLike(line) {
  const m = SHARE_HEAD.exec(line);
  return m && /^\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?(?::|=(?!>))/.test(m[2])
    ? m
    : null;
}

function translateShare(lines, i) {
  const m = SHARE_HEAD.exec(lines[i]);
  const name = m[1];
  let rest = m[2];
  let setter = null;
  const sm = /^\s*,\s*([A-Za-z_$][\w$]*)(.*)$/.exec(rest);
  if (sm) [, setter, rest] = sm;

  let stmt = rest;
  let consumed = 1;
  while (balance(stmt) > 0 && i + consumed < lines.length)
    stmt += "\n" + lines[i + consumed++];

  let comment = "";
  const lineStart = stmt.lastIndexOf("\n") + 1;
  const ci = commentIndex(stmt.slice(lineStart));
  if (ci >= 0) {
    comment = " " + stmt.slice(lineStart + ci).trim();
    stmt = stmt.slice(0, lineStart + ci);
  }
  stmt = stmt.replace(/[;\s]+$/, "");

  const r = /^\s*(?::\s*(.+?))?\s*(?:=(?!>)\s*([\s\S]*))?$/.exec(stmt);
  if (!r) return { error: MSG_SHARE_BAD };
  if (r[2] === undefined || r[2].trim() === "")
    return { error: MSG_SHARE_INIT };
  return {
    name,
    setter: setter ?? setterName(name),
    type: r[1] ? r[1].trim() : null,
    init: r[2],
    comment,
    consumed,
  };
}

function shareCode({ name, setter, type, init, comment }) {
  const N = name[0].toUpperCase() + name.slice(1);
  const store = `${name}$store`;
  const getter = `get${N}`;
  const hook = `use${N}`;
  const T = type ?? "any";
  const typed = [
    `const ${store}: { value: ${T}; listeners: Set<() => void> } = { value: ${init}, listeners: new Set() };${comment}`,
    `export const ${getter} = (): ${T} => ${store}.value;`,
    `export const ${setter} = (next: ${T} | ((prev: ${T}) => ${T})): void => {`,
    `  ${store}.value = typeof next === 'function' ? (next as (prev: ${T}) => ${T})(${store}.value) : (next as ${T});`,
    `  ${store}.listeners.forEach((listener) => listener());`,
    `};`,
    `export const ${hook} = (): ${T} =>`,
    `  useSyncExternalStore(`,
    `    (listener: () => void) => {`,
    `      ${store}.listeners.add(listener);`,
    `      return () => {`,
    `        ${store}.listeners.delete(listener);`,
    `      };`,
    `    },`,
    `    ${getter},`,
    `    ${getter},`,
    `  );`,
  ]
    .join("\n")
    .split("\n");
  const plain = [
    `const ${store} = { value: ${init}, listeners: new Set() };${comment}`,
    `export const ${getter} = () => ${store}.value;`,
    `export const ${setter} = (next) => {`,
    `  ${store}.value = typeof next === 'function' ? next(${store}.value) : next;`,
    `  ${store}.listeners.forEach((listener) => listener());`,
    `};`,
    `export const ${hook} = () =>`,
    `  useSyncExternalStore(`,
    `    (listener) => {`,
    `      ${store}.listeners.add(listener);`,
    `      return () => {`,
    `        ${store}.listeners.delete(listener);`,
    `      };`,
    `    },`,
    `    ${getter},`,
    `    ${getter},`,
    `  );`,
  ]
    .join("\n")
    .split("\n");
  return { typed, plain, hook, getter };
}

function declaresLocally(it, name) {
  const id = esc(name);
  const word = `(?<![\\w$.])${id}(?![\\w$])`;
  if (new RegExp(word).test(it.rest)) return true;
  const body = stripNoise(it.lines.slice(1).join("\n"));
  return (
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${id}\\b`).test(body) ||
    new RegExp(`\\[[^\\]]*${word}[^\\]]*\\]\\s*=`).test(body) ||
    new RegExp(`\\{[^}]*${word}[^}]*\\}\\s*=(?!=|>)`).test(body)
  );
}

function translateHook(lines, i) {
  const m = HOOK_HEAD.exec(lines[i]);
  if (!m) return null;
  const [, indent, kind, name, rest0] = m;

  let rest = rest0;
  let setter = null;
  if (kind === "state") {
    const sm = /^\s*,\s*([A-Za-z_$][\w$]*)(.*)$/.exec(rest);
    if (sm) [, setter, rest] = sm;
  }

  let stmt = rest;
  let consumed = 1;
  while (balance(stmt) > 0 && i + consumed < lines.length)
    stmt += "\n" + lines[i + consumed++];

  let comment = "";
  const lineStart = stmt.lastIndexOf("\n") + 1;
  const ci = commentIndex(stmt.slice(lineStart));
  if (ci >= 0) {
    comment = " " + stmt.slice(lineStart + ci).trim();
    stmt = stmt.slice(0, lineStart + ci);
  }
  stmt = stmt.replace(/[;\s]+$/, "");

  let type = null;
  let init = null;
  if (kind === "state" || kind === "ref") {
    const r = /^\s*(?::\s*(.+?))?\s*(?:=(?!>)\s*([\s\S]*))?$/.exec(stmt);
    if (!r) return null;
    type = r[1] ? r[1].trim() : null;
    init = r[2] ?? null;
  } else if (kind === "id") {
    if (!/^\s*$/.test(stmt)) return null;
  } else {
    const r = /^\s*=(?!>)\s*([\s\S]+)$/.exec(stmt);
    if (!r) return null;
    init = r[1];
  }

  const make = (T) => {
    if (kind === "state")
      return [
        `const [${name}, ${setter ?? setterName(name)}] = useState${T}(${init ?? ""});`,
        "useState",
      ];
    if (kind === "ref")
      return [`const ${name} = useRef${T}(${init ?? ""});`, "useRef"];
    if (kind === "id") return [`const ${name} = useId();`, "useId"];
    if (kind === "deferred")
      return [`const ${name} = useDeferredValue(${init});`, "useDeferredValue"];
    return [`const ${name} = useContext(${init});`, "useContext"];
  };
  const [code, hook] = make(type ? `<${type}>` : "");
  const [plain] = make("");
  const toLines = (c) => (indent + c + comment).split("\n");
  return {
    out: toLines(code),
    plainOut: toLines(plain),
    consumed,
    hook,
    typed: !!type,
  };
}

function parse(source, main, warnings) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const st = { block: false, tpl: false };
  const stp = { block: false, tpl: false };
  let depth = 0;
  let pdepth = 0;
  let pending = {};
  let current = null;

  const loose = (l) => {
    const last = items[items.length - 1];
    if (last && last.t === "loose") last.lines.push(l);
    else items.push({ t: "loose", file: main, lines: [l] });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const top = !current && depth === 0 && !st.block && !st.tpl;

    if (top && /^use\s/.test(line)) {
      let stmt = line;
      while (!USE_COMPLETE.test(stmt) && i + 1 < lines.length)
        stmt += "\n" + lines[++i];
      items.push({ t: "import", file: main, stmt: convertUse(stmt) });
      continue;
    }

    if (top && /^\s*@/.test(line)) {
      Object.assign(pending, parseDecorators(line, warnings));
      continue;
    }

    if (top && line.trim() === "<variables>") {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "</variables>") {
        const l = lines[++i];
        if (hookLike(l)) throw hookError(i, l, MSG_TOP);
        if (shareLike(l)) throw hookError(i, l, MSG_SHARE_SCOPE);
        body.push(l);
      }
      i++;
      const code = dedent(body);
      items.push({
        t: "var",
        file: pending.path ?? main,
        lines: code,
        names: declaredNames(code),
      });
      pending = {};
      continue;
    }

    if (top && SHARE_HEAD.test(line)) {
      const sh = translateShare(lines, i);
      if (sh.error) throw hookError(i, line, sh.error);
      const code = shareCode(sh);
      items.push({
        t: "share",
        file: pending.path ?? main,
        lines: code.typed,
        typed: code.typed,
        plain: code.plain,
        name: sh.name,
        setter: sh.setter,
        type: sh.type,
        hook: code.hook,
        getter: code.getter,
        hooks: new Set(["useSyncExternalStore"]),
      });
      pending = {};
      i += sh.consumed - 1;
      continue;
    }

    if (top) {
      const m = DECL.exec(line);
      if (m && !NOT_DECL.has(m[3])) {
        current = {
          t: "fn",
          file: pending.path ?? main,
          lines: [],
          indent: m[1],
          name: m[3],
          rest: m[4],
          mode: m[2] ? "default" : pending.noExport ? "none" : "named",
          plainRest: stripHeaderTypes(m[4]),
          edits: [],
          hooks: new Set(),
        };
        items.push(current);
        pending = {};
      }
    }

    if (current && !top && pdepth === 0 && !st.block && !st.tpl) {
      if (shareLike(line)) throw hookError(i, line, MSG_SHARE_SCOPE);
      const like = hookLike(line);
      if (like && like[2] !== "state" && /^\s*,/.test(like[4]))
        throw hookError(i, line, MSG_SETTER);
      if (depth === 1) {
        const t = translateHook(lines, i);
        if (t) {
          if (t.typed)
            current.edits.push({
              start: current.lines.length,
              count: t.out.length,
              plain: t.plainOut,
            });
          for (const l of t.out) {
            current.lines.push(l);
            depth += scanLine(l, st);
            pdepth += scanLine(l, stp, "paren");
          }
          current.hooks.add(t.hook);
          i += t.consumed - 1;
          continue;
        }
      } else if (depth > 1 && like && translateHook(lines, i)) {
        throw hookError(i, line, MSG_NESTED);
      }
    }

    if (!current && top && hookLike(line)) throw hookError(i, line, MSG_TOP);

    if (current) current.lines.push(line);
    else loose(line);

    pdepth += scanLine(line, stp, "paren");
    depth += scanLine(line, st);
    if (current && depth === 0 && !st.block && !st.tpl) current = null;
  }

  if (pending.path || pending.noExport)
    warnings.push("decorator without a function or <variables> right after it");
  return items;
}

function parseImport(stmt) {
  const m =
    /^import\s+(?:([\s\S]*?)\s+from\s+)?(["'][^"'\n]+["'])\s*;?\s*$/.exec(stmt);
  if (!m) return { raw: stmt, sideEffect: true };
  if (!m[1]) return { raw: stmt, sideEffect: true, mod: m[2] };
  let rest = m[1];
  const typeOnly = /^type\s+/.test(rest);
  rest = rest.replace(/^type\s+/, "");
  let named = [];
  const nm = /\{([\s\S]*)\}/.exec(rest);
  if (nm) {
    named = nm[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((spec) => {
        const am = /\bas\s+([\w$]+)$/.exec(spec);
        return { spec, local: am ? am[1] : spec.replace(/^type\s+/, "") };
      });
    rest = rest.replace(nm[0], "");
  }
  let ns = null;
  const sm = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (sm) {
    ns = sm[1];
    rest = rest.replace(sm[0], "");
  }
  const def = rest.replace(/,/g, "").trim() || null;
  return { raw: stmt, mod: m[2], typeOnly, def, ns, named };
}

function filterImport(imp, used, file) {
  const def =
    imp.def && (imp.def === "React" || used(imp.def)) ? imp.def : null;
  const ns = imp.ns && used(imp.ns) ? imp.ns : null;
  const named = imp.named.filter((n) => used(n.local));
  const parts = [];
  if (def) parts.push(def);
  if (ns) parts.push(`* as ${ns}`);
  if (named.length) parts.push(`{ ${named.map((n) => n.spec).join(", ")} }`);
  if (!parts.length) return null;
  return `import ${imp.typeOnly ? "type " : ""}${parts.join(", ")} from ${rebaseMod(imp.mod, file)};`;
}

function rebaseMod(mod, file) {
  const q = mod[0];
  const spec = mod.slice(1, -1);
  if (!/^\.\.?\//.test(spec)) return mod;
  let r = path.relative(path.dirname(file), path.normalize(spec));
  if (!r.startsWith(".")) r = "./" + r;
  return q + r + q;
}

const hasJsx = (code) =>
  /(?<![\w$)\]])<\/?\s*[A-Za-z][\w$.]*[\s/>]/.test(stripStrings(code));

function retarget(p, ext, code = "") {
  return p.replace(/\.(jsx|tsx|js|ts)$/, (_, e) => {
    const jsx = e === "jsx" || e === "tsx" || hasJsx(code);
    return ext === "tsx" ? (jsx ? ".tsx" : ".ts") : jsx ? ".jsx" : ".js";
  });
}

function relImport(from, to) {
  const r = path.relative(path.dirname(from), to.replace(/\.(jsx?|tsx?)$/, ""));
  return r.startsWith(".") ? r : "./" + r;
}

function renderItem(it, needExport, ts = true) {
  if (it.t === "loose") return it.lines;
  if (it.t === "import") return [it.stmt];
  if (it.t === "share") return ts ? it.typed : it.plain;
  if (it.t === "var") {
    const out = [...it.lines];
    for (const d of it.names)
      if (!d.exported && needExport.has(d.name))
        out[d.line] = "export " + out[d.line];
    return out;
  }
  const exp =
    it.mode === "default"
      ? "export default "
      : it.mode === "named"
        ? "export "
        : "";
  let body = it.lines.slice(1);
  if (!ts) {
    body = [...it.lines];
    for (const e of [...it.edits].reverse())
      body.splice(e.start, e.count, ...e.plain);
    body = body.slice(1);
  }
  return [
    `${it.indent}${exp}function ${it.name}${ts ? it.rest : it.plainRest}`,
    ...body,
  ];
}

function stripStrings(text) {
  return text
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}
function stripNoise(text) {
  return stripStrings(text.replace(/>[^<>{}]*</g, "><"));
}

const REACT_HOOKS = new Set([
  "useState",
  "useEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
  "useReducer",
  "useLayoutEffect",
  "useId",
  "useTransition",
  "useDeferredValue",
  "useSyncExternalStore",
  "useImperativeHandle",
  "useDebugValue",
  "useInsertionEffect",
  "useOptimistic",
  "useActionState",
]);

function undefinedNames(code) {
  const text = stripNoise(code);
  const candidates = new Map();

  for (const m of stripStrings(code).matchAll(
    /(?<![\w$)\]])<\/?\s*([A-Z][\w$]*)/g,
  ))
    candidates.set(m[1], "tag");
  for (const m of text.matchAll(
    /(?<![\w$.])(use[A-Z][\w$]*)(?:<[^>()]*>)?\s*\(/g,
  )) {
    if (!candidates.has(m[1])) candidates.set(m[1], "hook");
  }

  const out = [];
  for (const [name, kind] of candidates) {
    const re = new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`, "g");
    let defined = false;
    for (const m of text.matchAll(re)) {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + name.length);
      const isTag = /<\/?\s*$/.test(before);
      const isCall =
        /^(?:<[^>()]*>)?\s*\(/.test(after) && !/function\*?\s+$/.test(before);
      if (!(isTag || (kind === "hook" && isCall))) {
        defined = true;
        break;
      }
    }
    if (!defined) out.push({ name, kind });
  }
  return out;
}

const importLines = (mods) =>
  [...mods].map(([mod, { def, named }]) => {
    const parts = [];
    if (def) parts.push(def);
    if (named.size) parts.push(`{ ${[...named].join(", ")} }`);
    return `import ${parts.join(", ")} from '${mod}';`;
  });

function packageName(spec) {
  if (
    /^[./~#]/.test(spec) ||
    /^@\//.test(spec) ||
    /^(data|https?|virtual):/.test(spec)
  )
    return null;
  const bare = spec.replace(/^node:/, "");
  if (spec.startsWith("node:") || builtinModules.includes(bare.split("/")[0]))
    return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function build(
  source,
  {
    main = "main.jsx",
    dir = "",
    globals = null,
    shares = null,
    extraExports = null,
    ext = null,
  } = {},
) {
  main = normalizePath(main);
  const warnings = [];
  const items = parse(source, main, warnings);
  const multi = items.some((it) => it.file !== main);
  const needExport = new Set(extraExports ?? []);
  const imports = items
    .filter((it) => it.t === "import")
    .map((it) => parseImport(it.stmt));

  const bound = new Set();
  for (const imp of imports) {
    if (imp.sideEffect) continue;
    if (imp.def) bound.add(imp.def);
    if (imp.ns) bound.add(imp.ns);
    for (const n of imp.named) bound.add(n.local);
  }

  const files = new Map([[main, []]]);
  for (const it of items) {
    if (it.t === "import") continue;
    if (!files.has(it.file)) files.set(it.file, []);
    files.get(it.file).push(it);
  }
  const rawText = (its) => its.flatMap((it) => it.lines).join("\n");
  const usedIn = (text) => (n) =>
    new RegExp(`(?<![\\w$])${esc(n)}(?![\\w$])`).test(text);
  const here = (f) => path.join(dir, f);

  const symbols = new Map();
  for (const [file, its] of files) {
    for (const it of its) {
      if (it.t === "fn") symbols.set(it.name, { file, kind: it.mode });
      if (it.t === "var")
        for (const d of it.names) symbols.set(d.name, { file, kind: "var" });
      if (it.t === "share")
        for (const n of [it.hook, it.setter, it.getter])
          symbols.set(n, { file, kind: "named" });
    }
  }

  const dependencies = new Set();
  const addDep = (mod) => {
    const n = mod && packageName(mod.slice(1, -1));
    if (n) dependencies.add(n);
  };

  const outName = (f) => (ext ? retarget(f, ext) : f);
  const fileIsTs = (file) => /\.tsx?$/.test(outName(file));
  const stripsTypes = (it) =>
    (it.t === "fn" && (it.edits.length > 0 || it.plainRest !== it.rest)) ||
    (it.t === "share" && it.type !== null);
  const warnTypes = (file, its) => {
    if (fileIsTs(file) || !its.some(stripsTypes)) return;
    warnings.push(
      `${outName(here(file))}: TypeScript types removed from state/ref/share and function signatures because it is not a .ts/.tsx file (use .tsx to keep the types)`,
    );
  };
  const checkFile = (file, code) => {
    for (const u of undefinedNames(code)) {
      if (knownProblem.has(u.name)) continue;
      const where = outName(here(file));
      warnings.push(
        u.kind === "tag"
          ? `<${u.name}> is used in ${where} but is neither declared nor imported (add a \`use\`)`
          : REACT_HOOKS.has(u.name)
            ? `${u.name} is used in ${where} but is not imported: use { ${u.name} } from "react"`
            : `${u.name}() is used in ${where} but is neither declared nor imported`,
      );
    }
  };

  const hooksByFile = new Map();
  for (const it of items) {
    if ((it.t !== "fn" && it.t !== "share") || !it.hooks.size) continue;
    if (!hooksByFile.has(it.file)) hooksByFile.set(it.file, new Set());
    for (const h of it.hooks) hooksByFile.get(it.file).add(h);
  }

  const knownProblem = new Set();
  const declared = [...symbols].map(([name, s]) => ({
    name,
    file: here(s.file),
    kind: s.kind,
  }));
  const declaredShares = items
    .filter((it) => it.t === "share")
    .map((it) => ({ name: it.name, hook: it.hook }));

  const externalUses = new Set();
  function linkFor(file, text) {
    const usedC = usedIn(stripNoise(text));
    const mods = new Map();
    const addImport = (name, kind, to) => {
      const mod = relImport(here(file), to);
      if (!mods.has(mod)) mods.set(mod, { def: null, named: new Set() });
      if (kind === "default") mods.get(mod).def = name;
      else mods.get(mod).named.add(name);
    };

    for (const [name, s] of symbols) {
      if (s.file === file || bound.has(name) || !usedC(name)) continue;
      if (s.kind === "none") {
        warnings.push(
          `${name} is marked @no-export but is used in ${file} (without export, the import cannot be generated)`,
        );
        knownProblem.add(name);
        continue;
      }
      addImport(name, s.kind, here(s.file));
      if (s.kind === "var") needExport.add(name);
    }

    if (globals) {
      for (const [name, g] of globals) {
        if (symbols.has(name) || bound.has(name) || !usedC(name)) continue;
        if (g.dups?.length) {
          warnings.push(
            `${name} exists in ${[g.jtx, ...g.dups].join(" and ")}; add \`use { ${name} } from "./path"\` to choose one`,
          );
          knownProblem.add(name);
          continue;
        }
        if (g.kind === "none") {
          warnings.push(
            `${name} (from ${g.jtx}) is marked @no-export but is used in ${here(file)}`,
          );
          knownProblem.add(name);
          continue;
        }
        addImport(name, g.kind, g.file);
        externalUses.add(name);
      }
    }

    for (const h of hooksByFile.get(file) ?? []) {
      if (bound.has(h)) continue;
      if (!mods.has("react"))
        mods.set("react", { def: null, named: new Set() });
      mods.get("react").named.add(h);
      addDep("'react'");
    }
    return mods;
  }

  const localShares = new Map();
  for (const it of items)
    if (it.t === "share")
      localShares.set(it.name, { hook: it.hook, jtx: null, dups: [] });
  const allShares = new Map([...(shares ?? []), ...localShares]);
  if (allShares.size) {
    for (const it of items) {
      if (it.t !== "fn") continue;
      const used = usedIn(stripNoise(it.lines.join("\n")));
      const injected = [];
      for (const [name, info] of allShares) {
        if (!used(name) || declaresLocally(it, name)) continue;
        if (info.dups?.length) {
          if (!knownProblem.has(name)) {
            warnings.push(
              `${name} is declared with share in ${[info.jtx, ...info.dups].join(" and ")}; rename one of them`,
            );
            knownProblem.add(name);
          }
          continue;
        }
        injected.push(`const ${name} = ${info.hook}();`);
      }
      if (!injected.length) continue;
      const first = it.lines
        .slice(1)
        .find((l) => l.trim() && !/^\s*\}/.test(l));
      const bodyIndent = first ? first.match(/^\s*/)[0] : it.indent + "  ";
      it.lines.splice(1, 0, ...injected.map((l) => bodyIndent + l));
      for (const e of it.edits) e.start += injected.length;
    }
  }

  const cross = new Map();
  for (const [file, its] of files) cross.set(file, linkFor(file, rawText(its)));

  if (!multi) {
    const chunks = items.map((it) =>
      renderItem(it, needExport, fileIsTs(it.file)),
    );
    const lines = importLines(cross.get(main));
    if (lines.length) {
      let at = -1;
      items.forEach((it, i) => {
        if (it.t === "import") at = i;
      });
      chunks.splice(at + 1, 0, at === -1 ? [...lines, ""] : lines);
    }
    const code = chunks.flat().join("\n");
    checkFile(main, code);
    warnTypes(main, files.get(main));
    for (const imp of imports) addDep(imp.mod);
    return {
      files: [{ path: main, code }],
      warnings,
      main,
      declared,
      declaredShares,
      externalUses,
      dependencies,
    };
  }

  const result = [];
  for (const [file, its] of files) {
    const text = rawText(its);
    const used = usedIn(text);
    const head = [];
    for (const imp of imports) {
      if (imp.sideEffect) {
        if (file === main) {
          head.push(imp.raw);
          addDep(imp.mod);
        }
        continue;
      }
      const s = filterImport(imp, used, file);
      if (s) {
        head.push(s);
        addDep(imp.mod);
      }
    }
    head.push(...importLines(cross.get(file)));
    const body = its
      .flatMap((it) => renderItem(it, needExport, fileIsTs(file)))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!body) continue;
    const code = (head.length ? head.join("\n") + "\n\n" : "") + body + "\n";
    checkFile(file, code);
    warnTypes(file, its);
    result.push({ path: file, code });
  }
  result.sort((a, b) => (b.path === main) - (a.path === main));
  return {
    files: result,
    warnings,
    main,
    declared,
    declaredShares,
    externalUses,
    dependencies,
  };
}

export function compileFiles(source, { main = "main.jsx" } = {}) {
  const { files, warnings, main: m, dependencies } = build(source, { main });
  return { files, warnings, main: m, dependencies: [...dependencies].sort() };
}

export function compile(source, options) {
  const { files, main } = compileFiles(source, options);
  return files.find((f) => f.path === main)?.code ?? "";
}

export function compileProject(entries, { ext = "jsx" } = {}) {
  const warnings = [];
  const fixExt = (p, code = "") => retarget(p, ext, code);
  const safe = (e, fn) => {
    try {
      return fn();
    } catch (err) {
      err.message = `${e.file}: ${err.message}`;
      throw err;
    }
  };
  const list = entries.map(({ file, source }) => {
    const f = normalizePath(file);
    const d = path.dirname(f);
    return {
      file: f,
      source,
      dir: d === "." ? "" : d,
      main: path.basename(f, ".jtx") + "." + ext,
    };
  });

  const globals = new Map();
  const globalShares = new Map();
  for (const e of list) {
    const first = safe(e, () => build(e.source, { main: e.main, dir: e.dir }));
    for (const d of first.declared) {
      const prev = globals.get(d.name);
      if (prev) prev.dups.push(e.file);
      else globals.set(d.name, { ...d, jtx: e.file, dups: [] });
    }
    for (const sh of first.declaredShares) {
      const prev = globalShares.get(sh.name);
      if (prev) prev.dups.push(e.file);
      else globalShares.set(sh.name, { hook: sh.hook, jtx: e.file, dups: [] });
    }
  }

  const results = new Map();
  const usedElsewhere = new Set();
  for (const e of list) {
    const r = safe(e, () =>
      build(e.source, {
        main: e.main,
        dir: e.dir,
        globals,
        shares: globalShares,
        ext,
      }),
    );
    results.set(e.file, r);
    for (const n of r.externalUses) usedElsewhere.add(n);
  }

  for (const e of list) {
    const r = results.get(e.file);
    if (r.declared.some((d) => d.kind === "var" && usedElsewhere.has(d.name))) {
      results.set(
        e.file,
        build(e.source, {
          main: e.main,
          dir: e.dir,
          globals,
          shares: globalShares,
          extraExports: usedElsewhere,
          ext,
        }),
      );
    }
  }

  const files = [];
  const projects = new Map();
  const seen = new Map();
  const deps = new Set();
  for (const e of list) {
    const r = results.get(e.file);
    r.dependencies.forEach((d) => deps.add(d));
    for (const w of r.warnings) warnings.push(`${e.file}: ${w}`);
    const outs = r.files.map((f) => ({
      path: fixExt(path.join(e.dir, f.path), f.code),
      code: f.code,
      from: e.file,
    }));
    for (const o of outs) {
      if (seen.has(o.path))
        warnings.push(
          `${o.path} is generated by ${seen.get(o.path)} and by ${e.file}`,
        );
      else seen.set(o.path, e.file);
    }
    files.push(...outs);
    projects.set(e.file, {
      main: fixExt(path.join(e.dir, r.main)),
      files: outs,
    });
  }
  return { files, warnings, projects, dependencies: [...deps].sort() };
}

export function missingDependencies(dependencies, root = ".") {
  const installed = (pkg) => {
    for (let dir = osResolve(root); ; dir = osDirname(dir)) {
      if (existsSync(osJoin(dir, "node_modules", pkg))) return true;
      if (osDirname(dir) === dir) return false;
    }
  };
  return dependencies.filter((d) => !installed(d));
}

export function dependencyMessage(missing) {
  return `Install your dependencies: npm i ${missing.join(" ")}`;
}