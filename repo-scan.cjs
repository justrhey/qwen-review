// Parse syntax; the model never creates dependency edges.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const { root, files } = JSON.parse(input);
    const known = new Set(files);
    const edges = [], external = [], unresolved = [], warnings = [];
    const safe = p => {
      const rel = path.relative(root, p);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(x => x.startsWith('.') || x === 'node_modules')) return false;
      let current = root;
      for (const part of rel.split(path.sep)) {
        current = path.join(current, part);
        try { if (fs.lstatSync(current).isSymbolicLink()) return false; } catch { break; }
      }
      return true;
    };
    const host = {
      fileExists: p => safe(p) && ts.sys.fileExists(p),
      readFile: p => safe(p) ? ts.sys.readFile(p) : undefined,
      readDirectory: () => [],
      directoryExists: p => p === root || (safe(p) && ts.sys.directoryExists(p)),
      getCurrentDirectory: () => root,
      useCaseSensitiveFileNames: true,
    };
    const configCache = new Map();
    function optionsFor(file) {
      let dir = path.dirname(file), config;
      while (dir === root || safe(dir)) {
        config = ['tsconfig.json', 'jsconfig.json'].map(n => path.join(dir, n)).find(p => host.fileExists(p));
        if (config || dir === root) break;
        dir = path.dirname(dir);
      }
      if (!config) return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
      if (!configCache.has(config)) {
        const read = ts.readConfigFile(config, host.readFile);
        const parsed = ts.parseJsonConfigFileContent(read.config || {}, host, path.dirname(config));
        if (read.error) warnings.push(`Cannot parse ${path.relative(root, config)}; some aliases may not resolve.`);
        configCache.set(config, { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, ...parsed.options });
      }
      return configCache.get(config);
    }
    for (const file of files.filter(p => /\.[cm]?[jt]sx?$/.test(p))) {
      const absolute = path.join(root, file);
      const source = ts.createSourceFile(file, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
      const options = optionsFor(absolute);
      if (source.parseDiagnostics.length) warnings.push(`Syntax errors in ${file}; only readable import declarations are mapped.`);
      function add(specifier, node, kind) {
        const spec = specifier.text;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const resolved = ts.resolveModuleName(spec, absolute, options, host).resolvedModule;
        let target = resolved ? path.relative(root, resolved.resolvedFileName).split(path.sep).join('/') : null;
        if (!target || !known.has(target)) {
          const base = path.resolve(path.dirname(absolute), spec);
          const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.svg'].map(ext => base + ext), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map(n => path.join(base, n))];
          target = candidates.map(p => path.relative(root, p).split(path.sep).join('/')).find(p => known.has(p));
        }
        const item = { source: file, specifier: spec, line, kind };
        if (target) edges.push({ ...item, target });
        else {
          const alias = Object.keys(options.paths || {}).some(p => spec.startsWith(p.split('*')[0]));
          (spec.startsWith('.') || spec.startsWith('/') || alias ? unresolved : external).push(item);
        }
      }
      function visit(node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier, node, node.importClause?.isTypeOnly ? 'type import' : 'import');
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier, node, node.isTypeOnly ? 'type export' : 're-export');
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) add(node.moduleReference.expression, node, 'require');
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const arg = node.arguments[0];
          if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) add(arg, node, node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import' : 'require');
          else unresolved.push({ source: file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind: 'computed import', specifier: arg?.getText(source) || '(missing argument)' });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    process.stdout.write(JSON.stringify({ edges, external, unresolved, warnings }));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
});
