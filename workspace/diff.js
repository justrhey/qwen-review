/* Parse Git's unified patch without interpreting source code as HTML. */
(function (scope) {
  function pathName(value) {
    if (value.startsWith('"')) {
      // Git quotes UTF-8 bytes as octal escapes, including unusual filenames.
      const bytes = [];
      const body = value.slice(1, value.lastIndexOf('"'));
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '\\') {
          const octal = body.slice(i + 1).match(/^[0-7]{3}/);
          if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
          bytes.push(...new TextEncoder().encode(({ t: '\t', n: '\n', r: '\r' })[body[++i]] || body[i]));
        } else bytes.push(...new TextEncoder().encode(body[i]));
      }
      value = new TextDecoder().decode(new Uint8Array(bytes));
    }
    return value.replace(/^[ab]\//, '');
  }
  function parse(patch) {
    const files = [];
    let file, hunk, oldLine, newLine;
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const names = line.slice(11).match(/^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
        file = { path: names ? pathName(names[2]) : line.slice(11), oldPath: '', newPath: '', hunks: [], metadata: [], added: 0, removed: 0 };
        files.push(file); hunk = null;
      } else if (!file) continue;
      else if (line.startsWith('@@ ')) {
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!match) continue;
        oldLine = Number(match[1]); newLine = Number(match[3]);
        hunk = { heading: line, rows: [] }; file.hunks.push(hunk);
      } else if (hunk && /^[ +\-]/.test(line)) {
        const type = line[0];
        hunk.rows.push({ type, text: line.slice(1), old: type === '+' ? null : oldLine++, new: type === '-' ? null : newLine++ });
        if (type === '+') file.added++;
        if (type === '-') file.removed++;
      } else if (hunk && line.startsWith('\\ No newline')) {
        const row = hunk.rows.at(-1); if (row) row.noNewline = true;
      } else if (!hunk && line.startsWith('--- ')) file.oldPath = pathName(line.slice(4));
      else if (!hunk && line.startsWith('+++ ')) file.newPath = pathName(line.slice(4));
      else if (!hunk && line && !line.startsWith('index ')) file.metadata.push(line);
    }
    for (const f of files) {
      const renamed = f.metadata.find(line => line.startsWith('rename to '));
      if (renamed) f.path = pathName(renamed.slice(10));
      f.path = f.newPath && f.newPath !== '/dev/null' ? f.newPath : f.oldPath || f.path;
    }
    return files;
  }
  function align(rows) {
    const result = [];
    for (let i = 0; i < rows.length;) {
      if (rows[i].type === ' ') { result.push([rows[i], rows[i]]); i++; continue; }
      const removed = [], added = [];
      while (i < rows.length && rows[i].type !== ' ') {
        (rows[i].type === '-' ? removed : added).push(rows[i++]);
      }
      for (let j = 0; j < Math.max(removed.length, added.length); j++) result.push([removed[j] || null, added[j] || null]);
    }
    return result;
  }
  const api = { parse, align };
  if (typeof module !== 'undefined') module.exports = api;
  scope.QwenDiff = api;
})(globalThis);
