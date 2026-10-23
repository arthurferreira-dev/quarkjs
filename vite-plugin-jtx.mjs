import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "vite";
import {
  compileProject,
  missingDependencies,
  dependencyMessage,
} from "./jtx.mjs";

const EXTS = [".jsx", ".tsx", ".js", ".ts"];
const clean = (id) => id.replace(/[?#].*$/, "");
const query = (id) => {
  const i = id.search(/[?#]/);
  return i < 0 ? "" : id.slice(i);
};

const USE_COMPLETE =
  /^use\s+(?:[\s\S]*?\s+from\s+)?(["'])([^"'\n]+)\1\s*;?\s*$/;
function useSpecifiers(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^use\s/.test(lines[i])) continue;
    let stmt = lines[i];
    let m;
    while (!(m = USE_COMPLETE.exec(stmt)) && i + 1 < lines.length)
      stmt += "\n" + lines[++i];
    if (m) out.push(m[2]);
  }
  return out;
}

function findJtx(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist"].includes(name) || name.startsWith("."))
      continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findJtx(full));
    else if (name.endsWith(".jtx")) found.push(full);
  }
  return found;
}

export default function jtx({ ext = "jsx" } = {}) {
  const virtualFiles = new Map();
  const mainOf = new Map();
  const extra = new Set();
  let lastWarnings = "";
  let lastMissing = "";
  let lastError = "";
  let root = normalizePath(process.cwd());

  function compileAll() {
    const files = new Set([...findJtx(root).map(normalizePath), ...extra]);
    const entries = [...files].map((abs) => ({
      file: normalizePath(path.relative(root, abs)),
      source: readFileSync(abs, "utf8"),
    }));
    const {
      files: outs,
      warnings,
      projects,
      dependencies,
    } = compileProject(entries, { ext });
    const abs = (rel) => normalizePath(path.resolve(root, rel));

    const next = new Map();
    for (const o of outs) next.set(abs(o.path), o.code);
    mainOf.clear();
    for (const [file, p] of projects) {
      const main = abs(p.main);
      mainOf.set(abs(file), main);
      if (!next.has(main)) next.set(main, "export {}\n");
    }

    const changed = [];
    for (const [p, code] of next)
      if (virtualFiles.get(p) !== code) changed.push(p);
    for (const p of virtualFiles.keys()) if (!next.has(p)) changed.push(p);
    virtualFiles.clear();
    for (const [p, code] of next) virtualFiles.set(p, code);
    return { changed, warnings, dependencies };
  }

  function report(warnings, warn) {
    const key = warnings.join("\n");
    if (key === lastWarnings) return;
    lastWarnings = key;
    for (const w of warnings) warn(`[jtx] ${w}`);
  }

  function reportError(err, log) {
    if (err.message === lastError) return;
    lastError = err.message;
    log(`[jtx] ${err.message}`);
  }

  function reportDeps(dependencies, warn) {
    const missing = missingDependencies(dependencies, root);
    const key = missing.join(" ");
    if (key === lastMissing) return;
    lastMissing = key;
    if (missing.length) warn(`[jtx] ${dependencyMessage(missing)}`);
  }

  function findVirtual(spec, importer) {
    const bases = [];
    if (spec.startsWith(".")) {
      if (!importer) return null;
      bases.push(path.resolve(path.dirname(clean(importer)), spec));
    } else if (spec.startsWith("/@fs/")) {
      let p = spec.slice(5);
      if (!/^[A-Za-z]:/.test(p)) p = "/" + p;
      bases.push(p);
    } else if (path.isAbsolute(spec)) {
      bases.push(path.join(root, spec), spec);
    }
    for (const b0 of bases) {
      const b = normalizePath(b0);
      for (const e of ["", ...EXTS]) if (virtualFiles.has(b + e)) return b + e;
    }
    return null;
  }

  function invalidate(server, paths) {
    const mods = [];
    for (const p of paths) {
      const mod = server.moduleGraph.getModuleById(p);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
        mods.push(mod);
      }
    }
    return mods;
  }

  return {
    name: "vite-plugin-jtx",
    enforce: "pre",

    config(userConfig) {
      const deps = new Set();
      for (const file of findJtx(
        path.resolve(userConfig.root ?? process.cwd()),
      )) {
        for (const spec of useSpecifiers(readFileSync(file, "utf8"))) {
          if (!/^[./]/.test(spec)) deps.add(spec);
        }
      }
      return deps.size ? { optimizeDeps: { include: [...deps] } } : null;
    },

    configResolved(config) {
      root = normalizePath(config.root);
    },

    configureServer(server) {
      const onFile = (file) => {
        if (!file.endsWith(".jtx")) return;
        try {
          const { changed, warnings, dependencies } = compileAll();
          report(warnings, (m) => server.config.logger.warn(m));
          reportDeps(dependencies, (m) => server.config.logger.warn(m));
          invalidate(server, changed);
          if (changed.length) server.ws.send({ type: "full-reload" });
          lastError = "";
        } catch (err) {
          reportError(err, (m) => server.config.logger.error(m));
        }
      };
      server.watcher.on("add", onFile);
      server.watcher.on("unlink", onFile);
    },

    buildStart() {
      try {
        const { warnings, dependencies } = compileAll();
        report(warnings, (m) => this.warn(m));
        reportDeps(dependencies, (m) => this.warn(m));
      } catch (err) {
        this.warn(`[jtx] ${err.message}`);
      }
    },

    async resolveId(source, importer, options) {
      const bare = clean(source);
      const q = query(source);

      if (bare.endsWith(".jtx")) {
        const r = await this.resolve(source, importer, { skipSelf: true });
        let file = r ? clean(r.id) : null;
        if (!file || !existsSync(file)) {
          const rootRel = bare.startsWith("/") ? path.join(root, bare) : null;
          file =
            rootRel && existsSync(rootRel)
              ? rootRel
              : path.resolve(
                  importer ? path.dirname(clean(importer)) : root,
                  bare,
                );
        }
        file = normalizePath(file);
        if (!existsSync(file)) return null;
        if (options?.scan) return file;

        if (!mainOf.has(file)) {
          extra.add(file);
          try {
            compileAll();
          } catch (err) {
            this.error(`[jtx] ${err.message}`);
          }
        }
        this.addWatchFile(file);
        const main = mainOf.get(file);
        return main ? main + q : null;
      }

      const found = findVirtual(bare, importer);
      return found ? found + q : null;
    },

    load(id) {
      const code = virtualFiles.get(clean(id));
      return code === undefined ? null : { code, map: null };
    },

    handleHotUpdate({ file, server }) {
      if (!file.endsWith(".jtx")) return;
      try {
        const { changed, warnings, dependencies } = compileAll();
        report(warnings, (m) => server.config.logger.warn(m));
        reportDeps(dependencies, (m) => server.config.logger.warn(m));
        lastError = "";
        return invalidate(server, changed);
      } catch (err) {
        reportError(err, (m) => server.config.logger.error(m));
        return [];
      }
    },
  };
}