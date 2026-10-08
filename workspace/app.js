const $ = id => document.getElementById(id);
let archifyAvailable = false;
const state = { token: '', root: '', graph: null, selected: '', trace: null, history: [], busy: false, runId: '', stopRequested: false, view: 'map', sourceOffset: 1, totalLines: 0, selectionVersion: 0, scanVersion: 0, viewport: { x: 0, y: 0, w: 1000, h: 600 }, fitted: null };
const svgNS = 'http://www.w3.org/2000/svg';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svgElement(tag, attrs) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function notice(text = '') {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function api(route, data = {}) {
  const response = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.token }, body: JSON.stringify({ root: state.root, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function fileButton(path, text = path, line = 0, className = 'source-link') {
  const button = element('button', text, className);
  button.type = 'button';
  button.title = path + (line ? ':' + line : '');
  button.addEventListener('click', () => selectFile(path, line));
  return button;
}

function renderTree() {
  const tree = $('file-tree');
  tree.replaceChildren();
  if (!state.graph) return;
  const filter = $('file-search').value.trim().toLowerCase();
  const groups = new Map();
  for (const file of state.graph.nodes.filter(n => n.id.toLowerCase().includes(filter))) {
    if (!groups.has(file.folder)) groups.set(file.folder, []);
    groups.get(file.folder).push(file);
  }
  const degree = new Map();
  state.graph.edges.forEach(e => {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });
  for (const [folder, files] of groups) {
    const section = element('details');
    section.open = true;
    const summary = element('summary', folder === '.' ? state.graph.name : folder);
    summary.title = folder;
    section.append(summary);
    for (const file of files) {
      const button = fileButton(file.id, '', 0, 'file-row' + (file.id === state.selected ? ' active' : ''));
      button.dataset.path = file.id;
      button.append(element('span', file.extension.slice(1).toUpperCase(), 'file-type'), element('span', file.name, 'file-name'));
      if (degree.get(file.id)) button.append(element('span', String(degree.get(file.id)), 'file-degree'));
      section.append(button);
    }
    tree.append(section);
  }
  if (!groups.size) tree.append(element('p', 'No matching files.', 'detail-empty'));
}

async function openProject(root, refresh = false) {
  if (state.busy) return notice('Stop the current review before changing or refreshing the project.');
  const version = ++state.scanVersion;
  $('open-project').disabled = true;
  $('refresh').disabled = true;
  notice('Parsing source files and import connections…');
  try {
    const graph = await api('scan', { root });
    if (version !== state.scanVersion) return;
    const oldRoot = state.root;
    state.root = graph.root;
    state.graph = graph;
    $('project-root').value = graph.root;
    localStorage.setItem('qwen-review-project', graph.root);
    $('file-count').textContent = graph.nodes.length + ' files';
    $('edge-count').textContent = graph.edges.length;
    $('scan-time').textContent = graph.scanned_at;
    if (oldRoot !== graph.root) {
      state.history = [];
      try { state.history = JSON.parse(localStorage.getItem('qwen-review-chat:' + graph.root) || '[]').filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string'); } catch { state.history = []; }
      renderConversation();
    }
    resetDiagram();
    const preferred = refresh && graph.nodes.some(n => n.id === state.selected) ? state.selected : graph.nodes.find(n => /(^|\/)App\.[jt]sx?$/.test(n.id))?.id || graph.nodes.find(n => /(^|\/)agent\.py$/.test(n.id))?.id || graph.nodes.find(n => /\.(jsx?|tsx?|py)$/.test(n.id))?.id || graph.nodes[0]?.id;
    renderTree();
    notice(graph.warnings.join(' '));
    if (preferred) await selectFile(preferred);
    else {
      state.selected = '';
      state.trace = null;
      $('selected-path').textContent = 'No source files found';
      $('connections-panel').replaceChildren(element('p', 'Choose a folder containing readable source files.', 'detail-empty'));
      $('source-content').replaceChildren();
      $('impact-panel').replaceChildren();
      $('connection-count').textContent = '0';
      $('impact-count').textContent = '0';
      $('chat-context').textContent = '▱ ' + graph.name;
      drawGraph();
    }
    if (state.view === 'changes') await loadDiff();
  } catch (error) { notice(error.message); }
  finally {
    $('open-project').disabled = false;
    $('refresh').disabled = false;
  }
}

function localTrace(path) {
  const imports = state.graph.edges.filter(e => e.source === path);
  const incoming = state.graph.edges.filter(e => e.target === path);
  const seen = new Set([path]), queue = [path];
  const reverse = new Map();
  for (const edge of state.graph.edges) {
    if (!reverse.has(edge.target)) reverse.set(edge.target, []);
    reverse.get(edge.target).push(edge.source);
  }
  while (queue.length) for (const source of reverse.get(queue.shift()) || []) if (!seen.has(source)) { seen.add(source); queue.push(source); }
  return { imports, imported_by: incoming, potential_dependents: [...seen].filter(p => p !== path).sort(), external: state.graph.external.filter(e => e.source === path), unresolved: state.graph.unresolved.filter(e => e.source === path) };
}

async function selectFile(path, line = 0) {
  if (!state.graph?.nodes.some(n => n.id === path)) return notice('That file is not in the current project snapshot. Rescan the project if it was added.');
  const version = ++state.selectionVersion;
  state.selected = path;
  state.trace = localTrace(path);
  state.sourceOffset = line ? Math.max(1, line - 12) : 1;
  $('selected-path').textContent = path;
  $('chat-context').textContent = '▱ ' + path;
  $('connection-count').textContent = state.trace.imports.length + state.trace.imported_by.length;
  $('impact-count').textContent = state.trace.potential_dependents.length;
  if ($('archify-scope').value === 'file') resetDiagram();
  renderTree();
  renderConnections();
  drawGraph();
  await loadSource(version, line);
  if (line && version === state.selectionVersion) setDetail('source');
}

function renderConnections() {
  const trace = state.trace;
  const group = element('div', undefined, 'connection-group');
  for (const [label, edges, targetKey] of [['IMPORTED BY', trace.imported_by, 'source'], ['IMPORTS', trace.imports, 'target']]) {
    const column = element('div', undefined, 'connection-column');
    column.append(element('h3', label + ' · ' + edges.length));
    for (const edge of edges) {
      const button = fileButton(edge[targetKey], '', targetKey === 'source' ? edge.line : 0, 'connection-item');
      button.append(element('strong', edge[targetKey]), element('small', `${edge.kind} · ${edge.source}:${edge.line}`));
      column.append(button);
    }
    if (!edges.length) column.append(element('p', 'No parsed local imports.', 'detail-empty'));
    group.append(column);
  }
  $('connections-panel').replaceChildren(group);
  if (trace.external.length) $('connections-panel').append(element('p', 'External: ' + [...new Set(trace.external.map(e => e.specifier))].join(', '), 'dependency-notes'));
  if (trace.unresolved.length) $('connections-panel').append(element('p', 'Unresolved or computed: ' + trace.unresolved.map(e => `${e.specifier} (line ${e.line})`).join(', '), 'dependency-notes'));
  $('impact-panel').replaceChildren(element('p', 'These files depend on the selected file through one or more imports. Review them when its exports or behavior change. This does not establish that they will break at runtime.', 'impact-note'));
  if (!trace.potential_dependents.length) $('impact-panel').append(element('p', 'No transitive import dependents found in this snapshot.', 'detail-empty'));
  for (const path of trace.potential_dependents) {
    const button = fileButton(path, '', 0, 'connection-item');
    button.append(element('strong', path));
    $('impact-panel').append(button);
  }
}

async function loadSource(version = state.selectionVersion, highlight = 0) {
  try {
    const source = await api('file', { path: state.selected, offset: state.sourceOffset, limit: 200 });
    if (version !== state.selectionVersion) return;
    state.totalLines = source.total_lines;
    $('source-content').replaceChildren();
    for (const text of source.content.split('\n')) {
      const line = parseInt(text, 10);
      const row = element('span', text, 'source-line' + (line === highlight ? ' highlight' : ''));
      if (line === highlight) row.id = 'highlighted-line';
      $('source-content').append(row);
    }
    $('source-range').textContent = `${source.offset}–${Math.min(source.total_lines, source.offset + 199)} / ${source.total_lines}`;
    $('source-prev').disabled = source.offset <= 1;
    $('source-next').disabled = source.offset + 200 > source.total_lines;
    if (highlight) requestAnimationFrame(() => $('highlighted-line')?.scrollIntoView({ block: 'center' }));
  } catch (error) { if (version === state.selectionVersion) $('source-content').textContent = error.message; }
}

function setDetail(name) {
  for (const key of ['connections', 'source', 'impact']) $(key + '-panel').hidden = key !== name;
  document.querySelectorAll('[data-detail]').forEach(b => b.classList.toggle('active', b.dataset.detail === name));
}

function updateViewport() {
  const { x, y, w, h } = state.viewport;
  $('graph').setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
}

function drawGraph() {
  $('graph-edges').replaceChildren();
  $('graph-nodes').replaceChildren();
  $('canvas-empty').hidden = Boolean(state.selected);
  if (!state.selected || !state.trace) return;
  $('map-title').textContent = state.selected.split('/').pop();
  const incoming = [...new Set(state.trace.imported_by.map(e => e.source))].filter(p => p !== state.selected);
  const outgoing = [...new Set(state.trace.imports.map(e => e.target))].filter(p => p !== state.selected && !incoming.includes(p));
  const shownIncoming = incoming.slice(0, 12), shownOutgoing = outgoing.slice(0, 12);
  const rows = Math.max(shownIncoming.length, shownOutgoing.length, 1);
  const positions = new Map([[state.selected, { x: 370, y: (rows - 1) * 100 / 2 + 165, role: 'selected' }]]);
  for (const [list, x, role] of [[shownIncoming, 70, 'incoming'], [shownOutgoing, 670, 'outgoing']]) list.forEach((p, i) => positions.set(p, { x, y: 165 + i * 100, role }));
  const distinct = new Set();
  for (const edge of [...state.trace.imports, ...state.trace.imported_by]) {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    const key = edge.source + '\0' + edge.target;
    if (!a || !b || edge.source === edge.target || distinct.has(key)) continue;
    distinct.add(key);
    const right = a.x < b.x;
    const ax = a.x + (right ? 218 : 0), bx = b.x + (right ? 0 : 218), ay = a.y + 34, by = b.y + 34;
    const bend = (ax + bx) / 2;
    const path = svgElement('path', { d: `M${ax},${ay} C${bend},${ay} ${bend},${by} ${bx},${by}`, class: 'graph-edge' });
    const title = svgElement('title', {});
    title.textContent = `${edge.source}:${edge.line} ${edge.kind} → ${edge.target}`;
    path.append(title);
    $('graph-edges').append(path);
  }
  for (const [path, pos] of positions) {
    const g = svgElement('g', { transform: `translate(${pos.x},${pos.y})`, class: 'graph-node ' + pos.role, tabindex: '0', role: 'button', 'aria-label': `Select ${path}` });
    g.append(svgElement('rect', { width: 218, height: 68, rx: 8 }));
    const type = svgElement('text', { x: 14, y: 16, class: 'node-type' });
    type.textContent = pos.role === 'selected' ? 'SELECTED MODULE' : pos.role === 'incoming' ? 'IMPORTED BY' : 'DEPENDENCY';
    const name = svgElement('text', { x: 14, y: 36 });
    const filename = path.split('/').pop();
    name.textContent = filename.length > 27 ? filename.slice(0, 25) + '…' : filename;
    const folder = svgElement('text', { x: 14, y: 54, class: 'node-path' });
    const dirname = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(project root)';
    folder.textContent = dirname.length > 35 ? '…' + dirname.slice(-33) : dirname;
    const title = svgElement('title', {});
    title.textContent = path;
    g.append(type, name, folder, title);
    g.addEventListener('click', () => selectFile(path));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFile(path); } });
    $('graph-nodes').append(g);
  }
  const height = Math.max(460, 165 + rows * 100 + 50);
  state.fitted = { x: 0, y: 0, w: 970, h: height };
  state.viewport = { ...state.fitted };
  updateViewport();
  const hidden = incoming.length + outgoing.length - shownIncoming.length - shownOutgoing.length;
  $('map-scope').textContent = hidden ? `${hidden} more neighbors listed below. Arrows show parsed imports.` : 'Arrows show parsed imports · Scroll to zoom · Drag to pan';
}

function zoom(factor) {
  const v = state.viewport;
  const w = Math.max(250, Math.min(4000, v.w * factor));
  const ratio = w / v.w;
  const h = v.h * ratio;
  state.viewport = { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
  updateViewport();
}

async function setView(view) {
  state.view = view;
  closeScopePicker();
  document.querySelector('.review-surface').classList.toggle('reviewing-project', view === 'archify' && $('archify-scope').value === 'project');
  document.querySelector('.review-surface').classList.toggle('reviewing-changes', view === 'changes');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  for (const key of ['map', 'archify', 'changes']) $(key + '-view').hidden = key !== view;
  if (view === 'changes' && state.root) await loadDiff();
}

let diffFiles = [], diffRequest = 0;
function renderDiff() {
  const container = $('diff-content');
  const scroll = container.parentElement.scrollTop;
  const collapsed = new Set([...container.querySelectorAll('details:not([open])')].map(node => node.dataset.path));
  container.replaceChildren();
  if (!diffFiles.length) container.append(element('p', 'No tracked source changes against HEAD.', 'diff-message'));
  for (const file of diffFiles) {
    const split = $('diff-layout').value === 'split' || ($('diff-layout').value === 'auto' && file.added + file.removed > 20 && container.clientWidth >= 640);
    const section = element('details', undefined, 'diff-file');
    section.open = !collapsed.has(file.path); section.dataset.path = file.path;
    const summary = element('summary');
    summary.append(element('strong', file.path), element('span', `+${file.added}`, 'diff-count-added'), element('span', `−${file.removed}`, 'diff-count-removed'), element('span', split ? 'Side by side' : 'Stacked', 'diff-mode'));
    section.append(summary);
    if (file.oldPath && file.oldPath !== '/dev/null' && file.oldPath !== file.newPath && file.newPath !== '/dev/null') section.append(element('p', 'Previously: ' + file.oldPath, 'diff-message'));
    if (!file.hunks.length) section.append(element('pre', file.metadata.join('\n') || 'No textual changes.', 'diff-message'));
    const region = element('div', undefined, 'diff-table-scroll');
    region.tabIndex = 0; region.setAttribute('role', 'region'); region.setAttribute('aria-label', file.path + ' changes');
    const table = element('table', undefined, split ? 'diff-table diff-split' : 'diff-table');
    table.setAttribute('aria-label', file.path + (split ? ': old and new side by side' : ': old and new stacked'));
    if (split) {
      const columns = element('colgroup');
      for (const width of ['4ch', '2ch', '', '4ch', '2ch', '']) { const col = element('col'); if (width) col.style.width = width; columns.append(col); }
      table.append(columns);
    }
    const head = element('thead'), header = element('tr');
    for (const label of split ? ['Before · HEAD', 'After · working tree'] : ['Before / after · − removed, + added']) {
      const cell = element('th', label); cell.colSpan = split ? 3 : 4; cell.scope = 'colgroup'; header.append(cell);
    }
    head.append(header); table.append(head);
    function cells(tr, row, side) {
      const type = row ? row.type : 'empty';
      const cls = type === '+' ? 'added' : type === '-' ? 'removed' : type === 'empty' ? 'blank' : 'context';
      const numbers = split ? [row && row[side]] : [row && row.old, row && row.new];
      for (const number of numbers) tr.append(element('td', number == null ? '' : String(number), 'diff-number ' + cls));
      tr.append(element('td', type === '+' ? '+' : type === '-' ? '−' : '', 'diff-sign ' + cls));
      const code = element('td', undefined, 'diff-code ' + cls);
      code.append(element('code', row ? row.text : ''));
      if (row && row.noNewline) code.append(element('span', 'No newline at end of file', 'diff-no-newline'));
      tr.append(code);
    }
    for (const hunk of file.hunks) {
      const body = element('tbody'), heading = element('tr');
      const cell = element('th', hunk.heading, 'diff-hunk'); cell.colSpan = split ? 6 : 4; heading.append(cell); body.append(heading);
      for (const pair of split ? QwenDiff.align(hunk.rows) : hunk.rows.map(row => [row])) {
        const tr = element('tr'); cells(tr, pair[0], 'old'); if (split) cells(tr, pair[1], 'new'); body.append(tr);
      }
      table.append(body);
    }
    if (file.hunks.length) { region.append(table); section.append(region); }
    container.append(section);
  }
  container.parentElement.scrollTop = scroll;
}
async function loadDiff() {
  const request = ++diffRequest, root = state.root;
  $('diff-content').textContent = 'Reading local Git changes…';
  $('diff-summary').textContent = '';
  $('load-diff').disabled = true;
  try {
    const diff = await api('diff');
    if (root !== state.root || request !== diffRequest) return;
    $('git-status').textContent = diff.status || 'Working tree clean for scanned source files.';
    diffFiles = QwenDiff.parse(diff.diff || '');
    $('diff-summary').textContent = `${diffFiles.length} files shown · +${diffFiles.reduce((n, f) => n + f.added, 0)} added · −${diffFiles.reduce((n, f) => n + f.removed, 0)} removed` + (diff.truncated ? ' · Partial diff: some changes are not loaded. Ask Qwen to inspect individual files.' : '');
    renderDiff();
  } catch (error) { if (request === diffRequest && root === state.root) $('diff-content').textContent = error.message; }
  finally { if (request === diffRequest) $('load-diff').disabled = false; }
}
$('diff-layout').addEventListener('change', renderDiff);
let diffWide = false;
new ResizeObserver(entries => {
  const wide = entries[0].contentRect.width >= 640;
  if (wide !== diffWide) { diffWide = wide; if (state.view === 'changes' && diffFiles.length && $('diff-layout').value === 'auto') renderDiff(); }
}).observe($('diff-content'));

const scopeOptions = [...document.querySelectorAll('[data-scope]')];
function syncScopePicker() {
  $('scope-value').textContent = $('archify-scope').selectedOptions[0].textContent;
  for (const option of scopeOptions) option.setAttribute('aria-selected', String(option.dataset.scope === $('archify-scope').value));
}
function closeScopePicker(returnFocus = false) {
  $('scope-options').hidden = true;
  $('scope-toggle').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('scope-toggle').focus();
}
function openScopePicker() {
  $('scope-options').hidden = false;
  $('scope-toggle').setAttribute('aria-expanded', 'true');
  scopeOptions.find(option => option.dataset.scope === $('archify-scope').value).focus();
}
$('scope-toggle').addEventListener('click', () => $('scope-options').hidden ? openScopePicker() : closeScopePicker());
$('scope-toggle').addEventListener('keydown', event => {
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openScopePicker(); }
});
for (const option of scopeOptions) {
  option.addEventListener('click', () => {
    const changed = $('archify-scope').value !== option.dataset.scope;
    $('archify-scope').value = option.dataset.scope;
    syncScopePicker(); closeScopePicker(true);
    if (changed) $('archify-scope').dispatchEvent(new Event('change'));
  });
  option.addEventListener('keydown', event => {
    const index = scopeOptions.indexOf(option);
    if (event.key === 'Escape') { event.preventDefault(); closeScopePicker(true); }
    else if (event.key === 'Tab') closeScopePicker();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? scopeOptions.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + scopeOptions.length) % scopeOptions.length;
      scopeOptions[next].focus();
    }
  });
}
document.addEventListener('pointerdown', event => { if (!event.target.closest('.scope-picker')) closeScopePicker(); });
document.addEventListener('focusin', event => { if (!event.target.closest('.scope-picker')) closeScopePicker(); });
let diagramRequest = 0;
function resetDiagram() {
  syncScopePicker();
  $('generate-diagram').disabled = $('archify-scope').value === 'file' && !archifyAvailable;
  document.querySelector('.review-surface').classList.toggle('reviewing-project', state.view === 'archify' && $('archify-scope').value === 'project');
  diagramRequest++;
  $('generate-diagram').textContent = $('archify-scope').value === 'project' ? 'Generate tree ↗' : 'Generate with Archify ↗';
  $('diagram-frame').hidden = true;
  $('archify-empty').hidden = false;
  $('download-diagram').hidden = true;
  $('archify-empty').querySelector('h2').textContent = $('archify-scope').value === 'project' ? 'Explore the whole project.' : 'A diagram you can explore.';
  $('archify-empty').querySelector('p').textContent = $('archify-scope').value === 'project' ? 'Explore a branching folder tree. Expand folders to see their files.' : 'Select a source file, then generate its Archify diagram.';
}
$('archify-scope').addEventListener('change', resetDiagram);
async function generateDiagram() {
  const scope = $('archify-scope').value;
  if (!state.root) return notice('Open a project first.');
  if (scope === 'file' && !state.selected) return notice('Select a source file first.');
  const button = $('generate-diagram'), version = state.selectionVersion, root = state.root, scan = state.scanVersion, request = ++diagramRequest;
  button.disabled = true;
  button.textContent = 'Rendering…';
  try {
    const result = await api('diagram', { path: state.selected, scope });
    if (root !== state.root || scan !== state.scanVersion || request !== diagramRequest || (scope === 'file' && version !== state.selectionVersion)) return;
    const url = '/diagram?id=' + encodeURIComponent(result.id);
    $('diagram-frame').src = url;
    $('diagram-frame').hidden = false;
    $('archify-empty').hidden = true;
    $('download-diagram').href = url;
    $('download-diagram').hidden = false;
    if (scope === 'project') notice(`Whole project: ${result.shown_files} scanned files. ${state.graph.warnings.join(' ')}`);
    else notice(result.shown_neighbors < result.total_neighbors ? `Diagram shows ${result.shown_neighbors} of ${result.total_neighbors} direct neighbors; all connections are listed below.` : '');
  } catch (error) { notice('Archify: ' + error.message); }
  finally { button.disabled = false; button.textContent = $('archify-scope').value === 'project' ? 'Generate tree ↗' : 'Generate with Archify ↗'; }
}

function appendInline(parent, text) {
  const pattern = /\[([^\]]+)\]\((source:[^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let match, cursor = 0;
  while ((match = pattern.exec(text))) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[1]) {
      const target = match[2].slice(7), lineMatch = target.match(/^(.*):(\d+)$/);
      const path = lineMatch ? lineMatch[1] : target;
      if (state.graph?.nodes.some(n => n.id === path)) parent.append(fileButton(path, match[1], lineMatch ? Number(lineMatch[2]) : 0));
      else parent.append(document.createTextNode(match[1]));
    } else if (match[3]) {
      const exact = state.graph?.nodes.find(n => n.id === match[3]);
      if (exact) parent.append(fileButton(exact.id, match[3]));
      else parent.append(element('code', match[3]));
    } else parent.append(element('strong', match[4]));
    cursor = pattern.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function formatContent(node, text) {
  node.replaceChildren();
  const chunks = text.split('```');
  chunks.forEach((chunk, i) => {
    if (i % 2) {
      node.append(element('pre', chunk.replace(/^\w*\n/, '')));
      return;
    }
    const lines = chunk.split('\n');
    lines.forEach((line, index) => {
      if (/^#{1,4} /.test(line)) {
        const heading = element('h4');
        appendInline(heading, line.replace(/^#{1,4} /, ''));
        node.append(heading);
      } else { appendInline(node, line); if (index < lines.length - 1) node.append(document.createTextNode('\n')); }
    });
  });
}

function addMessage(role, text) {
  const wrapper = element('div', undefined, 'message ' + role);
  if (role === 'assistant') wrapper.append(element('div', '✳  QWEN', 'message-label'));
  const tools = element('div', undefined, 'tool-steps');
  const body = element('div', undefined, 'message-body');
  wrapper.append(tools, body);
  formatContent(body, text);
  $('messages').append(wrapper);
  $('messages').scrollTop = $('messages').scrollHeight;
  return { wrapper, tools, body };
}

function renderConversation() {
  $('messages').querySelectorAll('.message').forEach(n => n.remove());
  $('chat-intro').hidden = Boolean(state.history.length);
  state.history.forEach(m => addMessage(m.role, m.content));
}

function saveHistory() {
  try { localStorage.setItem('qwen-review-chat:' + state.root, JSON.stringify(state.history.slice(-20))); } catch { notice('Browser storage is full; this chat could not be saved.'); }
}

async function sendQuestion(question) {
  if (state.busy) return;
  if (!state.root || !state.graph) return notice('Open a project first.');
  question = question.trim();
  if (!question) return;
  state.busy = true;
  state.runId = '';
  state.stopRequested = false;
  $('stop').hidden = false;
  $('send').hidden = true;
  $('new-chat').disabled = true;
  $('prompt').value = '';
  $('chat-intro').hidden = true;
  state.history.push({ role: 'user', content: question });
  addMessage('user', question);
  const answer = addMessage('assistant', 'Reading the project…');
  let text = '', done = false, failed = false;
  const tools = new Map();
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.token }, body: JSON.stringify({ root: state.root, selected_file: state.selected || null, messages: state.history.slice(-20) }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Qwen request failed');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function receive(event) {
      if (event.type === 'run') {
        state.runId = event.id;
        if (state.stopRequested) api('stop', { id: state.runId }).catch(error => notice(error.message));
      }
      if (event.type === 'text') {
        text += event.text;
        formatContent(answer.body, text);
      }
      if (event.type === 'action') {
        let item = tools.get(event.id);
        if (!item) {
          const details = element('details', undefined, 'tool-step');
          const summary = element('summary'), output = element('pre');
          details.append(summary, output);
          answer.tools.append(details);
          item = { details, summary, output, name: event.name };
          tools.set(event.id, item);
        }
        item.summary.textContent = `${event.status === 'done' ? '✓' : event.status === 'error' ? '!' : '…'} ${(event.summary || item.name || '').replaceAll('_', ' ')}`;
        if (event.output) item.output.textContent = event.output;
        item.details.classList.toggle('error', event.status === 'error');
      }
      if (event.type === 'notice') answer.tools.append(element('p', event.text, 'tool-step'));
      if (event.type === 'artifact') {
        const artifact = event.artifact;
        if (/^imports-[a-z0-9_]{8}$/.test(artifact?.id || '')) {
          $('archify-scope').value = 'file';
          syncScopePicker();
          const url = '/diagram?id=' + encodeURIComponent(artifact.id);
          $('diagram-frame').src = url;
          $('diagram-frame').hidden = false;
          $('archify-empty').hidden = true;
          $('download-diagram').href = url;
          $('download-diagram').hidden = false;
          setView('archify');
        }
      }
      if (event.type === 'error') { failed = true; answer.wrapper.append(element('p', event.text, 'chat-error')); }
      if (event.type === 'done') done = true;
      $('messages').scrollTop = $('messages').scrollHeight;
    }
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) receive(JSON.parse(line));
      }
      if (result.done) break;
    }
    if (buffer.trim()) receive(JSON.parse(buffer));
    if (!done && !failed) answer.wrapper.append(element('p', 'Review stopped before completion.', 'chat-error'));
    if (done && text.trim()) state.history.push({ role: 'assistant', content: text });
    else state.history.pop();
    if (!text.trim()) answer.body.textContent = done ? 'Qwen returned no explanation. Try a narrower question.' : 'No completed answer.';
  } catch (error) {
    answer.body.textContent = text || '';
    answer.wrapper.append(element('p', error.message, 'chat-error'));
    state.history.pop();
  } finally {
    state.busy = false;
    state.runId = '';
    $('stop').hidden = true;
    $('send').hidden = false;
    $('new-chat').disabled = false;
    saveHistory();
  }
}

function suggestedQuestion(kind) {
  const path = state.selected;
  if (kind !== 'review' && !path) return notice('Select a source file first.');
  if (kind === 'connections') return sendQuestion(`What connects to ${path}? Explain its direct imports and incoming imports. Cite source paths and lines.`);
  if (kind === 'impact') return sendQuestion(`What files could be affected if I change ${path}? Use the parsed transitive dependents, inspect relevant source, and explain possible impacts with uncertainty.`);
  if (kind === 'review') return sendQuestion('Review my current Git changes against HEAD. Use review_diff, then inspect changed code and relevant connections. Report only actionable issues supported by source with file and line references. Mention unreviewed or truncated changes.');
  return sendQuestion(`Explain ${path} using its actual source and connected files. What is its role, and how does it fit into this project? Cite source paths and lines.`);
}

$('project-form').addEventListener('submit', e => { e.preventDefault(); openProject($('project-root').value.trim()); });
$('refresh').addEventListener('click', () => openProject(state.root || $('project-root').value, true));
$('file-search').addEventListener('input', renderTree);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('[data-detail]').forEach(b => b.addEventListener('click', () => setDetail(b.dataset.detail)));
document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => suggestedQuestion(b.dataset.prompt)));
$('explain-file').addEventListener('click', () => suggestedQuestion('explain'));
$('review-changes').addEventListener('click', () => suggestedQuestion('review'));
$('load-diff').addEventListener('click', loadDiff);
$('generate-diagram').addEventListener('click', generateDiagram);
$('source-prev').addEventListener('click', () => { state.sourceOffset = Math.max(1, state.sourceOffset - 200); loadSource(); });
$('source-next').addEventListener('click', () => { state.sourceOffset += 200; loadSource(); });
$('fit').addEventListener('click', () => { if (state.fitted) state.viewport = { ...state.fitted }; updateViewport(); });
$('zoom-in').addEventListener('click', () => zoom(.8));
$('zoom-out').addEventListener('click', () => zoom(1.25));
$('graph').addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.1 : .9); }, { passive: false });
let drag = null;
$('graph').addEventListener('pointerdown', e => { if (e.target.closest('.graph-node')) return; drag = { x: e.clientX, y: e.clientY, viewport: { ...state.viewport } }; $('graph').setPointerCapture(e.pointerId); });
$('graph').addEventListener('pointermove', e => {
  if (!drag) return;
  const rectangle = $('graph').getBoundingClientRect();
  const scale = Math.min(rectangle.width / drag.viewport.w, rectangle.height / drag.viewport.h);
  state.viewport = { ...drag.viewport, x: drag.viewport.x - (e.clientX - drag.x) / scale, y: drag.viewport.y - (e.clientY - drag.y) / scale };
  updateViewport();
});
$('graph').addEventListener('pointerup', () => drag = null);
$('graph').addEventListener('pointercancel', () => drag = null);
$('chat-form').addEventListener('submit', e => { e.preventDefault(); sendQuestion($('prompt').value); });
$('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion($('prompt').value); } });
$('new-chat').addEventListener('click', () => { if (!state.busy) { state.history = []; renderConversation(); saveHistory(); } });
$('stop').addEventListener('click', async () => {
  state.stopRequested = true;
  if (!state.runId) return;
  try { await api('stop', { id: state.runId }); } catch (error) { notice(error.message); }
});

(async function start() {
  try {
    const response = await fetch('/api/bootstrap');
    const bootstrap = await response.json();
    state.token = bootstrap.token;
    $('model-status').textContent = bootstrap.model;
    archifyAvailable = bootstrap.archify;
    $('generate-diagram').disabled = !archifyAvailable;
    const root = localStorage.getItem('qwen-review-project') || bootstrap.default_root;
    $('project-root').value = root;
    await openProject(root);
  } catch (error) { notice(error.message); }
})();
