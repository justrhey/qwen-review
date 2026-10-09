const $ = id => document.getElementById(id);
const state = { ready:false, token: '', root: '', graph: null, selected: '', trace: null, history: [], provider: 'qwen', busy: false, runId: '', stopRequested: false, view: 'map', selectionVersion: 0, scanVersion: 0, viewport: { x: 0, y: 0, w: 1000, h: 600 }, fitted: null };
const svgNS = 'http://www.w3.org/2000/svg';
const drafts = new Map();
const expandedFolders = new Map();
let editorFile = null, editorSaving = false;
let watchingSource = false, diskChanged = false;
const implementationFiles = new Map();
let codingSessions = [], activeSession = '', sessionWrites = Promise.resolve();
const livePatches = new Map();
let livePatchPath = '', lastPatchPath = '', liveRenderVersion = 0;
const liveEditor = CodeUI.createEditor($('live-patch-code'), () => {}, () => {}, {readOnly:true, typing:true});
let attachments = [], attachmentsLoading = 0, jevConfigured = false;
let codexAccount = null, accountRefresh = null, accountAction = false, preparingRequest = false, editorLoading = false;
const sourceEditor = CodeUI.createEditor($('source-content'), (text, line) => {
  if (!editorFile) return;
  const key = editorFile.root + ':' + editorFile.path;
  if (text === editorFile.original) drafts.delete(key);
  else drafts.set(key, { ...editorFile, content: text });
  $('source-position').textContent = `Ln ${line.number}`;
  updateEditorStatus();
}, () => saveSource());

function updateEditorStatus() {
  const dirty = editorFile && drafts.has(editorFile.root + ':' + editorFile.path);
  $('source-state').textContent = editorLoading ? 'Loading…' : editorSaving ? 'Saving…' : dirty ? 'Unsaved changes' : editorFile ? 'Saved on disk' : 'Choose a file';
  $('source-save').disabled = !dirty || editorSaving || editorLoading || state.busy;
  $('implementation-status').textContent = diskChanged ? 'Changed on disk · reload' : dirty ? 'Unsaved' : state.busy ? 'Working…' : editorFile ? 'Ready' : 'Choose a file';
  renderImplementationFiles();
}

function renderImplementationFiles() {
  const container = $('implementation-files');
  container.replaceChildren();
  for (const path of implementationFiles.get(state.root) || []) {
    const button = element('button', path.split('/').pop() + (drafts.has(state.root + ':' + path) ? ' •' : ''));
    button.type = 'button'; button.title = path;
    button.setAttribute('aria-current', path === (livePatchPath || state.selected) ? 'page' : 'false');
    button.onclick = () => {
      if (state.busy && livePatches.has(path)) showLivePatch(path);
      else { closeLivePatch(); selectFile(path); }
    };
    container.append(button);
  }
}

function showLivePatch(path) {
  const patch = livePatches.get(path);
  if (!patch || state.view !== 'implement') return;
  const changed = livePatchPath !== path;
  const version = ++liveRenderVersion;
  livePatchPath = path;
  $('live-patch').hidden = false; $('source-content').hidden = true;
  $('live-patch-path').textContent = path;
  const status = patch.kind === 'delete' && patch.status === 'applied' ? 'Deleted' : patch.status === 'applied' ? 'Saved' : patch.status === 'error' ? 'Failed' : 'Writing…';
  $('live-patch-status').textContent = status;
  if (changed) liveEditor.set(patch.base ?? patch.content ?? '', path, $('follow-edits').checked ? patch.line : 0);
  if (typeof patch.content === 'string') {
    if (patch.status === 'error') liveEditor.update(patch.content);
    else {
      if (patch.status === 'applied' && liveEditor.text() !== patch.content) $('live-patch-status').textContent = 'Updating…';
      liveEditor.write(patch.content, $('follow-edits').checked).then(() => {
        if (version === liveRenderVersion && livePatchPath === path) $('live-patch-status').textContent = status;
      });
    }
  }
  liveEditor.measure();
}

function closeLivePatch() {
  liveRenderVersion++;
  liveEditor.cancelWriting();
  livePatchPath = '';
  $('live-patch').hidden = true; $('source-content').hidden = false;
  sourceEditor.measure();
}

function receiveLivePatch(event) {
  for (const change of event.changes || []) {
    if (typeof change.path !== 'string' || typeof change.diff !== 'string') continue;
    const previous = livePatches.get(change.path);
    const sameEdit = previous?.itemId === event.id;
    const base = sameEdit ? previous.base : change.kind === 'add' ? '' : editorFile?.root === state.root && editorFile.path === change.path ? editorFile.original : null;
    const hunk = [...change.diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].at(-1);
    const line = hunk ? Number(hunk[1]) + Math.max(0, Number(hunk[2] ?? 1) - 1) : 0;
    const patch = { ...change, itemId: event.id, status: event.status, base, line,
      content: QwenDiff.preview(base, change.diff) ?? (sameEdit ? previous.content : null) };
    livePatches.set(change.path, patch);
    patch.sourceReady = updateLiveSource(change.path, patch, state.root);
    lastPatchPath = change.path;
    const opened = implementationFiles.get(state.root) || [];
    if (!opened.includes(change.path)) opened.push(change.path);
    implementationFiles.set(state.root, opened);
    if ($('follow-edits').checked || livePatchPath === change.path) showLivePatch(change.path);
  }
  renderImplementationFiles();
  if (event.status === 'applied') schedulePreviewReload();
}

async function updateLiveSource(path, patch, root) {
  try {
    if (patch.kind === 'delete' && patch.status === 'applied') patch.content = '';
    else {
      const source = await api('editor/read', { root, path });
      if (patch.base === null) patch.base = source.content;
      patch.content = patch.status !== 'writing' ? source.content : QwenDiff.preview(patch.base, patch.diff) ?? source.content;
    }
    if (state.root === root && livePatches.get(path) === patch && livePatchPath === path) showLivePatch(path);
  } catch {
    // New files may not exist on disk until their streamed edit is applied.
  }
}

function implementationEvent(text) {
  const list = $('implementation-events');
  const item = element('li');
  item.append(element('time', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), element('span', text));
  list.prepend(item);
  while (list.children.length > 50) list.lastChild.remove();
}

async function watchImplementationSource() {
  if (state.view !== 'implement' || document.hidden || !editorFile || editorLoading || editorSaving || watchingSource) return;
  const file = editorFile, selection = state.selectionVersion;
  watchingSource = true;
  try {
    const source = await api('editor/read', { root: file.root, path: file.path });
    if (selection !== state.selectionVersion || editorFile !== file || editorSaving || editorLoading) return;
    if (source.version === file.version) return;
    if (drafts.has(file.root + ':' + file.path)) {
      diskChanged = true; updateEditorStatus(); return;
    }
    const content = source.content.replace(/\r\n/g, '\n');
    file.version = source.version; file.original = content;
    file.newline = source.content.includes('\r\n') ? '\r\n' : '\n';
    sourceEditor.update(content);
    diskChanged = false; updateEditorStatus();
    implementationEvent('Updated from disk · ' + file.path);
  } catch (error) { $('implementation-status').textContent = 'Live update unavailable · ' + error.message; }
  finally { watchingSource = false; }
}
setInterval(watchImplementationSource, 1000);

async function saveSource() {
  if (!editorFile || editorSaving || editorLoading || state.busy) return;
  const file = { ...editorFile }, content = sourceEditor.text(), key = file.root + ':' + file.path;
  if (!drafts.has(key)) return;
  editorSaving = true; updateEditorStatus();
  try {
    const diskContent = file.newline === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
    const result = await api('editor/save', { root: file.root, path: file.path, content: diskContent, version: file.version });
    if (editorFile?.root === file.root && editorFile?.path === file.path) {
      editorFile.version = result.version; editorFile.original = content;
      if (sourceEditor.text() === content) drafts.delete(key);
      else drafts.set(key, { ...editorFile, content: sourceEditor.text() });
    } else drafts.delete(key);
    notice('Saved ' + file.path);
    implementationEvent('Saved · ' + file.path);
  } catch (error) { notice(error.message); }
  finally { editorSaving = false; updateEditorStatus(); }
}

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

function syncCodexModel() {
  if (state.provider !== 'codex') return;
  const selected = $('codex-model').selectedOptions[0];
  $('model-status').textContent = 'Codex · ' + (selected?.textContent || 'CLI default');
}

async function applyCodexAccount(account) {
  const changed = codexAccount && codexAccount.account_id !== account.account_id;
  if (changed && state.provider === 'codex') saveHistory();
  codexAccount = account;
  $('assistant-mode').querySelector('[value=codex]').disabled = !account.installed;
  $('codex-account-status').textContent = account.label;
  $('codex-login').hidden = account.signed_in;
  $('codex-logout').hidden = !account.signed_in;
  $('codex-model').disabled = state.busy || !account.signed_in;
  const key = 'qwen-review-codex-model:' + (account.account_id || 'signed-out');
  const selected = localStorage.getItem(key) || '';
  $('codex-model').replaceChildren(new Option('CLI default', ''));
  for (const model of account.models || []) $('codex-model').append(new Option(model.name, model.id));
  if ([...$('codex-model').options].some(option => option.value === selected)) $('codex-model').value = selected;
  if (account.account_id && !localStorage.getItem('qwen-review-legacy-codex-account')) localStorage.setItem('qwen-review-legacy-codex-account', account.account_id);
  if (state.provider === 'codex') {
    $('send').disabled = !account.signed_in;
    $('assistant-status').textContent = account.signed_in ? 'Codex · online · can edit' : 'Codex · sign in required';
    syncCodexModel();
    if (changed) {
      await loadHistory(); renderConversation();
      notice(account.signed_in ? 'Codex account changed. Showing this account’s conversation.' : 'Signed out of Codex. Sign in to continue. Your editor changes are kept.');
    }
  }
}

function refreshCodexAccount() {
  if (state.busy || accountAction) return Promise.resolve(codexAccount);
  if (accountRefresh) return accountRefresh;
  $('codex-account-refresh').disabled = true;
  accountRefresh = (async () => {
    const response = await fetch('/api/codex/status');
    if (!response.ok) throw new Error('Could not refresh Codex account');
    const account = await response.json();
    if (!accountAction) await applyCodexAccount(account);
    return account;
  })().finally(() => { accountRefresh = null; $('codex-account-refresh').disabled = false; });
  return accountRefresh;
}

async function changeCodexAccount(action) {
  if (state.busy || accountAction) return;
  accountAction = true; $('codex-login').disabled = true; $('codex-logout').disabled = true;
  try {
    const result = await api('codex/' + action);
    if (action === 'logout') await applyCodexAccount(result);
    else notice(result.message);
  } catch (error) { notice(error.message); }
  finally { accountAction = false; $('codex-login').disabled = false; $('codex-logout').disabled = false; }
}

function renderAttachments() {
  const container = $('image-previews'); container.replaceChildren(); container.hidden = !attachments.length;
  attachments.forEach((image, index) => {
    const card = element('div', undefined, 'image-preview');
    const preview = element('img'); preview.src = `data:${image.mime};base64,${image.data}`; preview.alt = image.name;
    const remove = element('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + image.name);
    remove.onclick = () => { if (!state.busy) { attachments.splice(index, 1); renderAttachments(); } };
    card.append(preview, remove); container.append(card);
  });
}

async function addImages(files) {
  if (state.busy) return;
  attachmentsLoading++;
  try {
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { notice('Choose PNG, JPEG or WebP images.'); continue; }
      if (file.size > 2 * 1024 * 1024) { notice('Each image must be under 2 MiB.'); continue; }
      if (attachments.length >= 4) { notice('Attach up to four images.'); break; }
      const dataURL = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      attachments.push({name: file.name || 'Pasted image', mime: file.type, data: dataURL.split(',')[1]});
    }
    renderAttachments();
    if (attachments.length && state.provider !== 'codex') notice('Image ready. Choose Codex to send it.');
  } catch { notice('Could not read that image. Try pasting it again.'); }
  finally { attachmentsLoading--; }
}

let tokenRefresh = null;
const skillCatalogs = new Map();
let composerChoices = [], composerChoice = 0, composerMenuVersion = 0;

async function installedSkills() {
  const root = state.root;
  if (!skillCatalogs.has(root)) skillCatalogs.set(root, api('skills', {root}).then(result => result.skills).catch(error => { skillCatalogs.delete(root); throw error; }));
  return skillCatalogs.get(root);
}

function hideComposerMenu() {
  composerMenuVersion++;
  $('composer-menu').hidden = true;
  $('prompt').removeAttribute('aria-activedescendant');
  composerChoices = [];
}

function renderComposerMenu(label, choices) {
  composerChoices = choices.slice(0, 20); composerChoice = 0;
  $('composer-menu-label').textContent = label;
  $('composer-options').replaceChildren();
  for (const [index, choice] of composerChoices.entries()) {
    const button = element('button', choice.label);
    button.type = 'button'; button.id = 'composer-option-' + index;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === 0));
    if (choice.description) button.title = choice.description;
    button.onclick = () => choice.run();
    $('composer-options').append(button);
  }
  if (!choices.length) $('composer-options').append(element('p', 'No matches'));
  $('composer-menu').hidden = false;
  if (choices.length) $('prompt').setAttribute('aria-activedescendant', 'composer-option-0');
  else $('prompt').removeAttribute('aria-activedescendant');
}

async function updateComposerMenu() {
  hideComposerMenu();
  if (!state.root || state.busy) return;
  const text = $('prompt').value, cursor = $('prompt').selectionStart;
  const resume = text.match(/^\/resume(?:\s+(.*))?$/i);
  if (resume) {
    const query = (resume[1] || '').toLowerCase();
    renderComposerMenu('Resume session', codingSessions.filter(session => session.title.toLowerCase().includes(query)).map(session => ({ label: session.title, run: () => resumeSession(session.id) })));
    return;
  }
  if (/^\/\w*$/.test(text)) {
    const commands = [
      { name: 'resume', run: () => { $('prompt').value = '/resume '; updateComposerMenu(); $('prompt').focus(); } },
      { name: 'new', run: () => { hideComposerMenu(); newSession(); } },
      { name: 'skills', run: () => { $('prompt').value = '@'; updateComposerMenu(); $('prompt').focus(); } },
      { name: 'stop', run: () => { hideComposerMenu(); $('prompt').value = ''; stopRun(); } },
    ];
    renderComposerMenu('Commands', commands.filter(command => command.name.startsWith(text.slice(1))).map(command => ({label:'/' + command.name, run:command.run})));
    return;
  }
  const mention = text.slice(0, cursor).match(/(?:^|\s)@([\w:-]*)$/);
  if (!mention) return;
  const version = composerMenuVersion;
  renderComposerMenu('Loading skills…', []);
  try {
    const skills = await installedSkills();
    if (version !== composerMenuVersion) return;
    renderComposerMenu('Skills', skills.filter(skill => skill.name.toLowerCase().includes(mention[1].toLowerCase())).map(skill => ({
      label: '@' + skill.name, description: skill.description,
      run: () => {
        const start = cursor - mention[1].length - 1;
        $('prompt').setRangeText('@' + skill.name + ' ', start, cursor, 'end');
        hideComposerMenu(); $('prompt').focus();
      }
    })));
  } catch (error) { if (version === composerMenuVersion) { hideComposerMenu(); notice(error.message); } }
}

async function submitPrompt() {
  const text = $('prompt').value.trim();
  if (/^\/resume(?:\s|$)/i.test(text)) { await updateComposerMenu(); return; }
  if (text === '/new') { hideComposerMenu(); newSession(); return; }
  if (text === '/stop') { $('prompt').value = ''; hideComposerMenu(); await stopRun(); return; }
  if (text === '/skills') { $('prompt').value = '@'; await updateComposerMenu(); return; }
  hideComposerMenu(); await sendQuestion(text);
}

async function workspaceRequest(route, data = {}) {
  const body = JSON.stringify({ root: state.root, ...data });
  const send = () => fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': state.token }, body });
  let response = await send();
  if (response.status === 403 && (await response.clone().json()).error === 'Open the local workspace to make this request') {
    if (!tokenRefresh) tokenRefresh = fetch('/api/bootstrap').then(async result => {
      if (!result.ok) throw new Error('Could not reconnect to the workspace');
      state.token = (await result.json()).token;
    }).finally(() => { tokenRefresh = null; });
    await tokenRefresh;
    response = await send();
  }
  return response;
}

async function api(route, data = {}) {
  const response = await workspaceRequest(route, data);
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
  const focusedPath = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  const scroll = tree.scrollTop;
  tree.replaceChildren();
  if (!state.graph) return;
  const filter = $('file-search').value.trim().toLowerCase();
  const root = { name: state.graph.name, path: '', folders: new Map(), files: [] };
  for (const file of state.graph.nodes.filter(n => n.id.toLowerCase().includes(filter))) {
    let folder = root, path = '';
    for (const part of file.id.split('/').slice(0, -1)) {
      path = path ? path + '/' + part : part;
      if (!folder.folders.has(part)) folder.folders.set(part, {name:part,path,folders:new Map(),files:[]});
      folder = folder.folders.get(part);
    }
    folder.files.push(file);
  }
  if (!root.folders.size && !root.files.length) { tree.append(element('p', 'No matching files. Clear the search to see the project.', 'detail-empty')); return; }
  const opened = folderState();
  const degree = new Map();
  state.graph.edges.forEach(e => {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });
  function row(name, path, folder, depth) {
    const item = element('li', undefined, 'explorer-item' + (!folder && path === state.selected ? ' active' : ''));
    item.setAttribute('role', 'treeitem'); item.setAttribute('aria-label', path || name); item.tabIndex = -1;
    item.dataset.path = path; item.dataset.name = name; item.dataset.kind = folder ? 'folder' : 'file';
    item.title = state.root + (path ? '/' + path : '');
    if (!folder) item.setAttribute('aria-selected', String(path === state.selected));
    const content = element('div', undefined, 'explorer-row'); content.style.setProperty('--depth', depth);
    const chevron = element('span', folder ? '›' : '', 'tree-chevron'); chevron.setAttribute('aria-hidden', 'true');
    const icon = element('span', folder ? '▱' : name.split('.').pop().slice(0, 3).toUpperCase(), folder ? 'folder-icon-small' : 'file-type'); icon.setAttribute('aria-hidden', 'true');
    content.append(chevron, icon, element('span', name, 'file-name'));
    if (!folder && degree.has(path)) { const count = element('span', String(degree.get(path)), 'file-degree'); count.title = degree.get(path) + ' import connections'; count.setAttribute('aria-hidden', 'true'); content.append(count); }
    item.append(content);
    content.onclick = () => { focusTreeItem(item); if (folder) toggleFolder(item); else selectFile(path); };
    return item;
  }
  function addFolder(folder, depth) {
    const item = row(folder.name, folder.path, true, depth);
    const open = Boolean(filter) || opened.has(folder.path);
    item.setAttribute('aria-expanded', String(open));
    const group = element('ul', undefined, 'tree-children'); group.setAttribute('role', 'group'); group.hidden = !open;
    for (const child of [...folder.folders.values()].sort((a,b) => a.name.localeCompare(b.name))) group.append(addFolder(child, depth + 1));
    for (const file of folder.files.sort((a,b) => a.name.localeCompare(b.name))) group.append(row(file.name, file.id, false, depth + 1));
    item.append(group); return item;
  }
  const list = element('ul', undefined, 'explorer-tree'); list.setAttribute('role','tree'); list.setAttribute('aria-label','Project files'); list.append(addFolder(root, 0)); tree.append(list);
  const visible = visibleTreeItems();
  const target = visible.find(item => item.dataset.path === focusedPath) || visible.find(item => item.dataset.path === state.selected) || visible[0];
  if (target) { target.tabIndex = 0; if (focusedPath !== null) target.focus({preventScroll:true}); }
  tree.scrollTop = scroll;
}

function folderState() {
  if (!expandedFolders.has(state.root)) {
    let paths = [''];
    try { const saved = JSON.parse(localStorage.getItem('qwen-review-folders:' + state.root)); if (Array.isArray(saved)) paths = saved.filter(p => typeof p === 'string'); } catch {}
    expandedFolders.set(state.root, new Set(paths));
  }
  return expandedFolders.get(state.root);
}

function rememberFolders() {
  try { localStorage.setItem('qwen-review-folders:' + state.root, JSON.stringify([...folderState()])); } catch {}
}

function visibleTreeItems() {
  return [...$('file-tree').querySelectorAll('[role=treeitem]')].filter(item => !item.closest('[hidden]'));
}

function focusTreeItem(item) {
  $('file-tree').querySelectorAll('[role=treeitem]').forEach(node => node.tabIndex = node === item ? 0 : -1);
  item.focus({preventScroll:true}); item.scrollIntoView({block:'nearest',inline:'nearest'});
}

function toggleFolder(item, open = item.getAttribute('aria-expanded') !== 'true') {
  item.setAttribute('aria-expanded', String(open)); item.querySelector(':scope > [role=group]').hidden = !open;
  if (!$('file-search').value.trim()) { if (open) folderState().add(item.dataset.path); else folderState().delete(item.dataset.path); rememberFolders(); }
}

function revealPath(path = state.selected, focus = true, folder = false) {
  if (!state.graph) return;
  if (focus) $('file-search').value = '';
  const opened = folderState(); opened.add('');
  let parent = '';
  for (const part of (folder ? path.split('/') : path.split('/').slice(0,-1)).filter(Boolean)) { parent = parent ? parent + '/' + part : part; opened.add(parent); }
  rememberFolders(); renderTree();
  const item = visibleTreeItems().find(node => node.dataset.path === path);
  if (item) { if (focus) focusTreeItem(item); else item.scrollIntoView({block:'nearest',inline:'nearest'}); }
}

function renderSelectedPath() {
  const nav = $('selected-path'); nav.replaceChildren();
  const parts = [state.graph.name, ...state.selected.split('/')];
  parts.forEach((part,index) => {
    if (index) { const separator = element('span', '›', 'breadcrumb-separator'); separator.setAttribute('aria-hidden','true'); nav.append(separator); }
    const last = index === parts.length - 1;
    const node = element(last ? 'span' : 'button', part); node.title = index ? parts.slice(1,index+1).join('/') : state.root;
    if (last) node.setAttribute('aria-current','page');
    else { node.type = 'button'; node.onclick = () => revealPath(parts.slice(1,index+1).join('/'), true, true); }
    nav.append(node);
  });
  $('explorer-file-path').textContent = state.root + '/' + state.selected;
  $('copy-file-path').disabled = false;
  nav.scrollLeft = nav.scrollWidth;
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
      restorePreview();
      $('implementation-events').replaceChildren(element('li', 'Project opened · ' + graph.name));
      $('file-search').value = '';
      await loadHistory();
      renderConversation();
    }
    resetDiagram();
    const sessionFile = codingSessions.find(session => session.id === activeSession)?.file;
    const preferred = refresh && graph.nodes.some(n => n.id === state.selected) ? state.selected : graph.nodes.some(n => n.id === sessionFile) ? sessionFile : graph.nodes.find(n => /(^|\/)App\.[jt]sx?$/.test(n.id))?.id || graph.nodes.find(n => /(^|\/)agent\.py$/.test(n.id))?.id || graph.nodes.find(n => /\.(jsx?|tsx?|py)$/.test(n.id))?.id || graph.nodes[0]?.id;
    renderTree();
    notice(graph.warnings.join(' '));
    if (preferred) await selectFile(preferred);
    else {
      state.selected = '';
      state.trace = null;
      $('selected-path').textContent = 'No source files found';
      $('explorer-file-path').textContent = 'No file selected'; $('copy-file-path').disabled = true;
      $('connections-panel').replaceChildren(element('p', 'Choose a folder containing readable source files.', 'detail-empty'));
      editorFile = null; sourceEditor.set('', 'txt'); updateEditorStatus();
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
  closeLivePatch();
  state.selected = path;
  const opened = implementationFiles.get(state.root) || [];
  if (!opened.includes(path)) opened.push(path);
  implementationFiles.set(state.root, opened);
  renderImplementationFiles();
  state.trace = localTrace(path);
  renderSelectedPath();
  $('chat-context').textContent = '▱ ' + path;
  $('connection-count').textContent = state.trace.imports.length + state.trace.imported_by.length;
  $('impact-count').textContent = state.trace.potential_dependents.length;
  if ($('archify-scope').value === 'file') resetDiagram();
  revealPath(path, false);
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
  editorLoading = true; updateEditorStatus();
  try {
    const root = state.root, path = state.selected;
    const source = await api('editor/read', { path });
    if (version !== state.selectionVersion) return;
    const draft = drafts.get(root + ':' + path);
    editorFile = draft || { root, path, version: source.version, original: source.content.replace(/\r\n/g, '\n'), newline: source.content.includes('\r\n') ? '\r\n' : '\n' };
    diskChanged = Boolean(draft && draft.version !== source.version);
    sourceEditor.set(draft ? draft.content : source.content, path, highlight);
    sourceEditor.connections(state.trace.imports.map(edge => ({...edge, color:connectionColor(edge.target)})));
    $('source-language').textContent = path.split('.').pop().toUpperCase() + ' · UTF-8';
    $('source-position').textContent = `Ln ${highlight || 1}`;
    updateEditorStatus();
  } catch (error) { if (version === state.selectionVersion) { editorFile = null; sourceEditor.set('', 'txt'); notice(error.message); } }
  finally { if (version === state.selectionVersion) { editorLoading = false; updateEditorStatus(); } }
}

function setDetail(name) {
  for (const key of ['connections', 'source', 'impact']) $(key + '-panel').hidden = key !== name;
  document.querySelectorAll('[data-detail]').forEach(b => b.classList.toggle('active', b.dataset.detail === name));
  if (name === 'source') sourceEditor.measure();
}

function updateViewport() {
  const { x, y, w, h } = state.viewport;
  $('graph').setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
}

function connectionColor(path) {
  const palette = ['#79b8d5', '#b5a1d6', '#d1b078', '#76b9ac', '#cf94a9', '#93b978', '#8fa6d1', '#c6a18b'];
  const neighbors = [...new Set([...(state.trace?.imports || []).map(edge => edge.target), ...(state.trace?.imported_by || []).map(edge => edge.source)])].filter(file => file !== state.selected).sort();
  const index = Math.max(0, neighbors.indexOf(path));
  return palette[index] || `hsl(${Math.round(index * 137.508) % 360} 38% 66%)`;
}

function drawGraph() {
  $('graph-edges').replaceChildren();
  $('graph').querySelector('defs').replaceChildren();
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
    const color = connectionColor(edge.source === state.selected ? edge.target : edge.source);
    const markerId = 'connection-arrow-' + distinct.size;
    const marker = svgElement('marker', {id:markerId, viewBox:'0 0 10 10', refX:9, refY:5, markerWidth:5, markerHeight:5, orient:'auto-start-reverse'});
    marker.append(svgElement('path', {d:'M 0 0 L 10 5 L 0 10 z', fill:color}));
    $('graph').querySelector('defs').append(marker);
    path.style.stroke = color; path.style.markerEnd = `url(#${markerId})`;
    const title = svgElement('title', {});
    title.textContent = `${edge.source}:${edge.line} ${edge.kind} → ${edge.target}`;
    path.append(title);
    $('graph-edges').append(path);
  }
  for (const [path, pos] of positions) {
    const g = svgElement('g', { transform: `translate(${pos.x},${pos.y})`, class: 'graph-node ' + pos.role, tabindex: '0', role: 'button', 'aria-label': `Select ${path}` });
    const rectangle = svgElement('rect', { width:218, height:68, rx:8 });
    if (pos.role !== 'selected') rectangle.style.stroke = connectionColor(path);
    g.append(rectangle);
    const type = svgElement('text', { x: 14, y: 16, class: 'node-type' });
    if (pos.role !== 'selected') type.style.fill = connectionColor(path);
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

let previewURL = '', previewReloadTimer = null, previewDirty = false, previewConnected = false, previewLoadVersion = 0;

function localPreviewURL(value) {
  const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : 'http://' + value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) throw new Error('Enter a localhost URL, such as http://localhost:3000.');
  if ((url.port || (url.protocol === 'https:' ? '443' : '80')) === location.port) throw new Error('Use your app’s port, rather than the workspace port.');
  return url.href;
}

function restorePreview() {
  clearTimeout(previewReloadTimer);
  previewDirty = false; previewConnected = false; previewLoadVersion++;
  previewURL = '';
  try {
    const saved = localStorage.getItem('arko-preview:' + state.root);
    if (saved) previewURL = localPreviewURL(saved);
  } catch { /* Ignore unavailable or outdated browser preferences. */ }
  $('preview-frame').removeAttribute('src');
  $('preview-frame').hidden = true;
  $('preview-empty').hidden = false;
  $('preview-url').value = previewURL || 'http://localhost:3000';
  $('preview-reload').disabled = !previewURL;
  $('preview-external').hidden = !previewURL;
  if (previewURL) $('preview-external').href = previewURL;
  else $('preview-external').removeAttribute('href');
  if (state.view === 'preview' && previewURL) reloadPreview();
}

async function reloadPreview() {
  clearTimeout(previewReloadTimer);
  if (!previewURL) return;
  previewDirty = false;
  $('preview-empty').hidden = true;
  $('preview-frame').hidden = false;
  if (previewConnected) {
    $('preview-frame').contentWindow.postMessage({type:'arko-preview-refresh'}, new URL(previewURL).origin);
    return;
  }
  const version = ++previewLoadVersion, url = previewURL, root = state.root;
  try { await api('preview/connect', {url}); } catch {}
  if (version !== previewLoadVersion || root !== state.root || url !== previewURL) return;
  $('preview-frame').src = url;
}

function schedulePreviewReload() {
  if (!previewURL || !$('preview-live').checked) return;
  previewDirty = true;
  clearTimeout(previewReloadTimer);
  if (state.view === 'preview' && previewConnected) previewReloadTimer = setTimeout(() => {
    previewDirty = false;
    $('preview-frame').contentWindow.postMessage({type:'arko-preview-update'}, new URL(previewURL).origin);
  }, 100);
}

$('preview-frame').addEventListener('load', () => {
  previewConnected = false;
  if (previewURL) $('preview-frame').contentWindow.postMessage({type:'arko-preview-connect', live:$('preview-live').checked}, new URL(previewURL).origin);
});
window.addEventListener('message', event => {
  if (!previewURL || event.source !== $('preview-frame').contentWindow || event.origin !== new URL(previewURL).origin || !['arko-preview-ready','arko-preview-location'].includes(event.data?.type)) return;
  let url; try {url = localPreviewURL(event.data.href);} catch {return;}
  if (new URL(url).origin !== event.origin) return;
  previewConnected = true; previewURL = url;
  $('preview-url').value = url; $('preview-external').href = url;
  try {localStorage.setItem('arko-preview:' + state.root, url);} catch {}
});

$('preview-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const url = localPreviewURL($('preview-url').value);
    previewURL = url; previewConnected = false;
    $('preview-url').value = url;
    $('preview-reload').disabled = false;
    $('preview-external').href = url;
    $('preview-external').hidden = false;
    try { localStorage.setItem('arko-preview:' + state.root, url); } catch { notice('Preview opened, but its URL could not be saved.'); }
    reloadPreview();
  } catch (error) { notice(error.message); }
});
$('preview-reload').addEventListener('click', reloadPreview);
$('preview-live').addEventListener('change', () => {
  if (previewURL && previewConnected) $('preview-frame').contentWindow.postMessage({type:'arko-preview-live', live:$('preview-live').checked}, new URL(previewURL).origin);
  if ($('preview-live').checked) schedulePreviewReload();
  else { clearTimeout(previewReloadTimer); previewDirty = false; }
});
$('preview-mobile').addEventListener('click', () => {
  const mobile = $('preview-mobile').getAttribute('aria-pressed') !== 'true';
  $('preview-mobile').setAttribute('aria-pressed', String(mobile));
  $('preview-mobile').textContent = mobile ? 'Desktop' : 'Mobile';
  $('preview-frame').classList.toggle('mobile-preview', mobile);
});

async function setView(view) {
  document.querySelector('.review-surface').classList.remove('editor-expanded');
  $('source-expand').textContent = 'Expand ↗'; $('source-expand').setAttribute('aria-pressed', 'false');
  const changed = state.view !== view;
  state.view = view;
  document.querySelector('.review-surface').classList.toggle('implementing', view === 'implement');
  $('implementation-activity').hidden = view !== 'implement';
  if (view === 'implement') setDetail('source');
  else closeLivePatch();
  closeScopePicker();
  document.querySelector('.review-surface').classList.toggle('reviewing-project', view === 'archify' && $('archify-scope').value === 'project');
  document.querySelector('.review-surface').classList.toggle('reviewing-changes', view === 'changes');
  document.querySelector('.review-surface').classList.toggle('previewing', view === 'preview');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  for (const key of ['map', 'archify', 'changes', 'implement', 'preview']) $(key + '-view').hidden = key !== view;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (changed) {
    const panel = $(view + '-view');
    panel.classList.remove('view-enter');
    void panel.offsetWidth;
    panel.classList.add('view-enter');
  }
  if (view === 'changes' && state.root) await loadDiff();
  if (view === 'implement') { sourceEditor.measure(); watchImplementationSource(); }
  if (view === 'preview' && previewURL) { if (!$('preview-frame').hasAttribute('src')) reloadPreview(); else if (previewDirty) schedulePreviewReload(); }
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

function formatContent(node, text) {
  CodeUI.renderMarkdown(node, text, (target, label) => {
    let path;
    try { path = decodeURIComponent(target).replace(/^source:/, ''); } catch { return null; }
    if (path.startsWith(state.root + '/')) path = path.slice(state.root.length + 1);
    const reference = path.match(/^(.*?)(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L\d+)?)?$/);
    const file = reference?.[1];
    if (state.graph?.nodes.some(n => n.id === file)) return fileButton(file, label, Number(reference[2] || reference[3] || 0));
    return null;
  });
}

function chatNearBottom() {
  const panel = $('messages');
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 64;
}

function scrollChat() {
  $('messages').scrollTo({ top: $('messages').scrollHeight, behavior: 'instant' });
}

function addMessage(role, text, animate = false, model = '') {
  const wrapper = element('div', undefined, 'message ' + role + (animate ? ' forge-enter' : ''));
  if (role === 'assistant') wrapper.append(element('div', '✳  ' + (state.provider === 'codex' ? 'CODEX' + (model ? ' · ' + model : '') : 'QWEN'), 'message-label'));
  const tools = element('div', undefined, 'tool-steps');
  const body = element('div', undefined, 'message-body');
  wrapper.append(body);
  formatContent(body, text);
  $('messages').append(wrapper);
  scrollChat();
  return { wrapper, tools, body, lastKind: 'text' };
}

function actionPresentation(event) {
  const name = (event.name || '').replace(/[_-]/g, '').toLowerCase();
  let detail = event.summary || event.name || '';
  const shell = detail.match(/^(?:\/\S*\/)?(?:bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (shell) detail = shell[2];
  if (name === 'filechange') {
    const paths = (event.changes || []).map(change => change.path).filter(path => typeof path === 'string');
    if (!paths.length) for (const [path, patch] of livePatches) if (patch.itemId === event.id) paths.push(path);
    detail = paths.map(path => path.startsWith(state.root + '/') ? path.slice(state.root.length + 1) : path).join(', ');
    return { icon: 'file', label: paths.length > 1 ? 'Edit files' : 'Edit file', detail };
  }
  if (name === 'jevgate') return {icon:'tool', label:'JEV scope', detail};
  if (name === 'jeveval') return {icon:'search', label:'JEV check', detail};
  if (name.includes('reason')) return { icon: 'reason', label: 'Reasoning', detail: event.summary || '' };
  if (name.includes('read') || name === 'viewfile') return { icon: 'file', label: 'Read file', detail };
  if (name.includes('search')) return { icon: 'search', label: 'Search', detail };
  if (name.includes('command') || name.includes('exec') || name === 'shell') {
    const read = detail.match(/^(?:cat\s+|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+)\s+)([^;&|]+)$/);
    if (read) return { icon: 'file', label: 'Read file', detail: read[1].replace(/^(['"])(.*)\1$/, '$2') };
    return { icon: 'command', label: 'Run command', detail };
  }
  return { icon: 'tool', label: 'Use tool', detail };
}

function actionIcon(kind) {
  const paths = {
    file: 'M9 3H4v14h12V8z M9 3v5h7 M7 11h6 M7 14h6',
    command: 'm4 5 5 5-5 5 M11 15h5',
    search: 'M13 13l4 4 M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0',
    reason: 'M10 3v14 M10 4C5 0 2 5 4 8c-4 4 0 9 6 8 M10 4c5-4 8 1 6 4 4 4 0 9-6 8 M5 8h3 M12 12h4',
    tool: 'm10 2 7 4v8l-7 4-7-4V6z M3 6l7 4 7-4 M10 10v8'
  };
  const icon = document.createElementNS(svgNS, 'svg');
  icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('class', 'action-icon'); icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.3');
  icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', paths[kind]); icon.append(path);
  return icon;
}

function setActionStatus(details, status) {
  details.dataset.status = status;
  details.querySelector('.action-status').setAttribute('aria-label', status === 'running' ? 'Working' : status === 'done' ? 'Complete' : 'Failed or stopped');
}

function renderConversation() {
  $('messages').querySelectorAll('.message').forEach(n => n.remove());
  $('chat-intro').hidden = Boolean(state.history.length);
  state.history.forEach(m => addMessage(m.role, m.content, false, m.model));
}

function historyKey(root) {
  return 'qwen-review-chat:' + root + (state.provider === 'codex' ? ':codex:' + (codexAccount?.account_id || 'signed-out') : '');
}

async function loadHistory() {
  const key = historyKey(state.root), root = state.root;
  try {
    if (root && state.token) {
      await sessionWrites;
      const local = JSON.parse(localStorage.getItem(key + ':sessions') || 'null');
      try {
        const result = await api('sessions/load', {provider:state.provider, account_id:codexAccount?.account_id});
        if (key !== historyKey(state.root)) return;
        if (result.saved && (!local || (local.updatedAt && result.saved.updatedAt > local.updatedAt))) localStorage.setItem(key + ':sessions', JSON.stringify(result.saved));
      } catch { /* Keep the browser's saved sessions if the server is unavailable. */ }
    }
    const stored = JSON.parse(localStorage.getItem(historyKey(state.root) + ':sessions') || 'null');
    if (stored && Array.isArray(stored.sessions) && stored.sessions.length) {
      codingSessions = stored.sessions.filter(session => typeof session.id === 'string' && Array.isArray(session.messages));
      if (codingSessions.length) {
        const session = codingSessions.find(session => session.id === stored.active) || codingSessions[0];
        activeSession = session.id;
        state.history = session.messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
        renderSessions(); return;
      }
    }
    let saved = localStorage.getItem(historyKey(state.root));
    if (!saved && state.provider === 'codex' && codexAccount?.account_id === localStorage.getItem('qwen-review-legacy-codex-account')) saved = localStorage.getItem('qwen-review-chat:' + state.root + ':codex');
    state.history = JSON.parse(saved || '[]').filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
  } catch { state.history = []; }
  activeSession = crypto.randomUUID();
  codingSessions = [{ id: activeSession, title: state.history.find(m => m.role === 'user')?.content.slice(0, 60) || 'New session', messages: state.history.slice() }];
  renderSessions();
}

function renderSessions() {
  $('coding-session').replaceChildren(...codingSessions.map(session => new Option(session.title, session.id)));
  $('coding-session').value = activeSession;
  $('coding-session').disabled = state.busy || !state.root;
  $('new-session').disabled = state.busy || !state.root;
  $('resume-task').hidden = !codingSessions.find(session => session.id === activeSession)?.interrupted;
  $('resume-task').disabled = state.busy;
}

function newSession() {
  if (state.busy || preparingRequest || accountAction || !state.root) return;
  saveHistory();
  activeSession = crypto.randomUUID();
  codingSessions.unshift({ id: activeSession, title: 'New session', messages: [] });
  state.history = []; attachments = []; renderAttachments(); $('prompt').value = '';
  $('implementation-events').replaceChildren(element('li', 'New coding session started.'));
  $('implementation-run-state').textContent = 'Ready';
  renderConversation(); saveHistory(); $('prompt').focus();
}

async function switchAssistant() {
  if (state.busy) return;
  saveHistory();
  state.provider = $('assistant-mode').value;
  localStorage.setItem('qwen-review-provider', state.provider);
  const codex = state.provider === 'codex';
  await loadHistory();
  $('assistant-status').textContent = codex ? 'Codex · online · can edit' : 'Qwen3.5 · local';
  $('model-status').textContent = codex ? 'Codex · your account' : 'Qwen3.5 · 2B';
  document.querySelector('.local-pill').lastChild.textContent = codex ? ' Online with Codex' : ' On your machine';
  $('assistant-note').textContent = codex ? 'Uses your Codex account online. Requested edits run in this project.' : 'Verify review findings against the linked source.';
  $('prompt').placeholder = codex ? 'Ask Codex…' : 'Ask Qwen…';
  $('prompt').setAttribute('aria-label', codex ? 'Question for Codex' : 'Question for Qwen');
  $('review-changes').textContent = codex ? 'Ask Codex to review ↗' : 'Ask Qwen to review ↗';
  $('codex-model-field').hidden = !codex;
  $('codex-account-row').hidden = !codex;
  $('jev-row').hidden = !codex;
  $('execution-row').hidden = !codex;
  $('send').disabled = codex && !codexAccount?.signed_in;
  syncCodexModel();
  renderConversation();
  if (codex) { try { await refreshCodexAccount(); } catch (error) { notice(error.message); } }
}
$('assistant-mode').addEventListener('change', switchAssistant);

function saveHistory() {
  const session = codingSessions.find(session => session.id === activeSession);
  if (session) {
    session.messages = state.history.slice(-20);
    session.title = state.history.find(m => m.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 60) || session.title;
    session.file = state.selected;
    session.updatedAt = Date.now();
  }
  try {
    localStorage.setItem(historyKey(state.root), JSON.stringify(state.history.slice(-20)));
    const saved = {active:activeSession, sessions:codingSessions, updatedAt:Date.now()};
    localStorage.setItem(historyKey(state.root) + ':sessions', JSON.stringify(saved));
    if (state.root && state.token && (state.provider !== 'codex' || codexAccount?.signed_in)) {
      const payload = JSON.parse(JSON.stringify({root:state.root, provider:state.provider, account_id:codexAccount?.account_id, saved}));
      sessionWrites = sessionWrites.catch(() => {}).then(async () => {
        const result = await workspaceRequest('sessions/save', payload);
        if (!result.ok) throw new Error('Could not save sessions to disk');
      }).catch(() => notice('Session is saved in this browser; disk backup will retry on the next change.'));
    }
  } catch { notice('Browser storage is full; this chat could not be saved.'); }
  renderSessions();
}

async function sendQuestion(question, pendingRun = null) {
  if (!state.ready || state.busy || preparingRequest || accountAction) return;
  if (!state.root || !state.graph) return notice('Open a project first.');
  if (!pendingRun && ['implement', 'preview'].includes(state.view) && [...drafts.values()].some(file => file.root === state.root)) return notice('Save or reload your unsaved files before asking the assistant to implement changes.');
  question = question.trim();
  if (attachmentsLoading) return notice('Wait for the image preview to finish loading.');
  if (!question && !attachments.length) return;
  if (attachments.length && state.provider !== 'codex') return notice('Choose Codex to send images. Qwen currently supports text only.');
  const skillNames = pendingRun ? [] : [...new Set([...question.matchAll(/(?:^|\s)@([\w:-]+)/g)].map(match => match[1]))];
  if (skillNames.length && state.provider !== 'codex') return notice('Use Codex for skills.');
  if (skillNames.length) {
    const skillRoot = state.root;
    preparingRequest = true;
    try {
      const available = await installedSkills();
      const missing = skillNames.find(name => !available.some(skill => skill.name === name));
      if (missing) return notice('Unknown skill: @' + missing);
    } catch (error) { return notice(error.message); }
    finally { preparingRequest = false; }
    if (state.busy || accountAction || state.root !== skillRoot || state.provider !== 'codex') return;
  }
  if (state.provider === 'codex') {
    preparingRequest = true;
    try { const account = await refreshCodexAccount(); if (!account?.signed_in) return notice('Sign in to Codex to send your request.'); }
    catch (error) { return notice(error.message); }
    finally { preparingRequest = false; }
    if (state.busy || accountAction || state.provider !== 'codex') return;
  }
  if (!question) question = 'Please review the attached image in the context of this project.';
  const images = pendingRun ? [] : attachments.slice();
  const model = pendingRun?.runModel ?? (state.provider === 'codex' ? $('codex-model').value : '');
  const jevEnabled = state.provider === 'codex' && jevConfigured && $('jev-enabled').checked;
  state.busy = true;
  livePatches.clear(); lastPatchPath = ''; closeLivePatch();
  $('implementation-run-state').textContent = 'Working';
  implementationEvent('Request started · ' + question);
  state.runId = pendingRun?.runId || crypto.randomUUID().replaceAll('-', '');
  const runSession = codingSessions.find(session => session.id === activeSession);
  if (runSession) { runSession.runId = state.runId; runSession.runModel = model; if (!pendingRun) delete runSession.interrupted; }
  state.stopRequested = false;
  $('stop').hidden = false;
  $('send').hidden = true;
  $('new-chat').disabled = true;
  $('assistant-mode').disabled = true;
  $('codex-model').disabled = true;
  $('jev-enabled').disabled = true;
  $('full-access').disabled = true;
  $('attach-image').disabled = true;
  $('codex-login').disabled = true; $('codex-logout').disabled = true;
  updateEditorStatus();
  document.querySelector('.chat-panel').setAttribute('aria-busy', 'true');
  $('prompt').value = '';
  $('chat-intro').hidden = true;
  if (!pendingRun) state.history.push({ role: 'user', content: question });
  saveHistory();
  const userMessage = pendingRun ? null : addMessage('user', question, true);
  for (const image of images) { const preview = element('img'); preview.src = `data:${image.mime};base64,${image.data}`; preview.alt = image.name; preview.className = 'sent-image'; userMessage.wrapper.append(preview); }
  const answer = addMessage('assistant', '', true, model || (state.provider === 'codex' ? 'CLI default' : ''));
  const waiting = element('div', 'Working on your request…', 'assistant-wait');
  answer.wrapper.append(waiting);
  let text = '', done = false, failed = false, rejected = false;
  const tools = new Map();
  try {
    const response = pendingRun ? await workspaceRequest('run', { id: state.runId, account_id: codexAccount?.account_id }) : await workspaceRequest('chat', { request_id: state.runId, selected_file: state.selected || null, messages: state.history.slice(-20), provider: state.provider, codex_model: model, account_id: codexAccount?.account_id, images, jev_enabled: jevEnabled, full_access:$('full-access').checked, live: ['implement', 'preview'].includes(state.view), skills: skillNames });
    if (!response.ok) {
      rejected = true;
      if (pendingRun && response.status === 404 && runSession) delete runSession.runId;
      throw new Error((await response.json()).error || 'Assistant request failed');
    }
    attachments = []; renderAttachments();
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function receive(event) {
      const follow = chatNearBottom();
      if (event.type === 'patch') { waiting.hidden = true; receiveLivePatch(event); }
      if (event.type === 'run') {
        state.runId = event.id;
        if (state.stopRequested) api('stop', { id: state.runId }).catch(error => notice(error.message));
      }
      if (event.type === 'text') {
        waiting.hidden = true;
        text += event.text;
        if (event.block || answer.lastKind !== 'text') { answer.body = element('div', undefined, 'message-body'); answer.wrapper.insertBefore(answer.body, waiting); answer.segment = ''; }
        answer.segment = (answer.segment || '') + event.text;
        formatContent(answer.body, answer.segment);
        answer.lastKind = 'text';
      }
      if (event.type === 'action') {
        waiting.hidden = true;
        if (event.status === 'done' || event.status === 'error') {
          implementationEvent((event.status === 'error' ? 'Failed · ' : 'Completed · ') + (event.summary || event.name || 'Action'));
          watchImplementationSource();
        }
        let item = tools.get(event.id);
        if (!item) {
          const details = element('details', undefined, 'tool-step forge-enter');
          const summary = element('summary'), output = element('pre');
          details.append(summary, output);
          if (answer.lastKind !== 'action') {
            answer.tools = element('details', undefined, 'tool-steps');
            answer.tools.open = true;
            answer.tools.append(element('summary', 'Actions'));
            answer.wrapper.insertBefore(answer.tools, waiting);
          }
          answer.tools.append(details); answer.lastKind = 'action';
          const label = element('span', undefined, 'action-label');
          const context = element('span', undefined, 'action-context');
          const status = element('span', undefined, 'action-status'); status.setAttribute('role', 'status');
          summary.append(actionIcon('tool'), label, context, status);
          item = { details, summary, output, label, context, name: event.name };
          tools.set(event.id, item);
        }
        const presentation = actionPresentation({ ...event, name: event.name || item.name });
        item.summary.querySelector('.action-icon').replaceWith(actionIcon(presentation.icon));
        item.label.textContent = presentation.label;
        item.context.textContent = presentation.detail;
        item.summary.title = [presentation.label, presentation.detail].filter(Boolean).join(' · ');
        setActionStatus(item.details, ['running', 'pending'].includes(event.status) ? 'running' : event.status === 'done' ? 'done' : 'error');
        if (event.output) item.output.textContent = event.output;
        if (event.output_delta) item.output.textContent += event.output_delta;
        item.details.classList.toggle('error', event.status === 'error');
      }
      if (event.type === 'notice') answer.wrapper.insertBefore(element('p', event.text, 'tool-step'), waiting);
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
      if (event.type === 'error') { failed = true; if (event.interrupted && runSession) runSession.interrupted = true; answer.wrapper.append(element('p', event.text, 'chat-error')); }
      if (event.type === 'done') { done = true; schedulePreviewReload(); }
      if (follow) scrollChat();
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
    if ((done || failed) && text.trim()) state.history.push({ role: 'assistant', content: text, model });
    if (runSession) delete runSession.runId;
    if (!text.trim()) answer.body.textContent = done ? 'The assistant returned no explanation. Try a narrower question.' : 'No completed answer.';
  } catch (error) {
    if (!text) answer.body.textContent = '';
    answer.wrapper.append(element('p', error.message, 'chat-error'));
    if (rejected && !pendingRun) { state.history.pop(); if (runSession) delete runSession.runId; }
  } finally {
    if (done && state.view === 'implement') {
      await livePatches.get(livePatchPath)?.sourceReady;
      await liveEditor.whenWritten();
    } else liveEditor.cancelWriting();
    waiting.remove();
    answer.wrapper.querySelectorAll('[data-status="running"]').forEach(item => setActionStatus(item, 'error'));
    document.querySelector('.chat-panel').setAttribute('aria-busy', 'false');
    state.busy = false;
    renderSessions();
    $('implementation-run-state').textContent = done && !failed ? 'Complete' : state.stopRequested ? 'Stopped' : 'Incomplete';
    implementationEvent('Request ' + $('implementation-run-state').textContent.toLowerCase());
    state.runId = '';
    $('stop').hidden = true;
    $('send').hidden = false;
    $('new-chat').disabled = false;
    $('assistant-mode').disabled = false;
    $('codex-model').disabled = false;
    $('jev-enabled').disabled = !jevConfigured;
    $('full-access').disabled = false;
    $('attach-image').disabled = false;
    $('codex-login').disabled = false; $('codex-logout').disabled = false;
    updateEditorStatus();
    saveHistory();
    if (state.provider === 'codex' && done) {
      if (lastPatchPath && $('follow-edits').checked && state.view === 'implement') state.selected = lastPatchPath;
      closeLivePatch(); await openProject(state.root, true);
    } else if (livePatchPath) {
      $('live-patch-status').textContent = 'Not completed';
    }
    if (state.provider === 'codex') { try { await refreshCodexAccount(); } catch (error) { notice(error.message); } }
  }
}

function suggestedQuestion(kind) {
  const path = state.selected;
  if (kind !== 'review' && !path) return notice('Select a source file first.');
  if (kind === 'connections') return sendQuestion(`What connects to ${path}? Explain its direct imports and incoming imports. Cite source paths and lines.`);
  if (kind === 'impact') return sendQuestion(`What files could be affected if I change ${path}? Use the parsed transitive dependents, inspect relevant source, and explain possible impacts with uncertainty.`);
  if (kind === 'review') return sendQuestion('Review my current Git changes against HEAD. ' + (state.provider === 'codex' ? 'Use git diff HEAD, then inspect changed code and relevant imports. Do not edit files. ' : 'Use review_diff, then inspect changed code and relevant connections. ') + 'Report only actionable issues supported by source with file and line references. Mention unreviewed or truncated changes.');
  return sendQuestion(`Explain ${path} using its actual source and connected files. What is its role, and how does it fit into this project? Cite source paths and lines.`);
}

$('project-form').addEventListener('submit', e => { e.preventDefault(); openProject($('project-root').value.trim()); });
$('refresh').addEventListener('click', () => openProject(state.root || $('project-root').value, true));
$('file-search').addEventListener('input', renderTree);
$('reveal-file').addEventListener('click', () => revealPath());
$('collapse-folders').addEventListener('click', () => { if (!state.graph) return; expandedFolders.set(state.root,new Set([''])); rememberFolders(); renderTree(); });
$('copy-file-path').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.root + '/' + state.selected); notice('Copied full file path.'); } catch { notice('Select and copy the path below the Explorer.'); } });
let treeSearch = '', treeSearchTime = 0;
$('file-tree').addEventListener('keydown', event => {
  const item = event.target.closest('[role=treeitem]'); if (!item) return;
  const visible = visibleTreeItems(), index = visible.indexOf(item), parent = item.parentElement.closest('[role=treeitem]');
  const folder = item.dataset.kind === 'folder', open = item.getAttribute('aria-expanded') === 'true';
  let target;
  if (event.key === 'ArrowDown') target = visible[Math.min(index+1,visible.length-1)];
  else if (event.key === 'ArrowUp') target = visible[Math.max(0,index-1)];
  else if (event.key === 'Home') target = visible[0];
  else if (event.key === 'End') target = visible.at(-1);
  else if (event.key === 'ArrowRight') { if (folder && !open) toggleFolder(item,true); else if (folder) target = item.querySelector('[role=group] > [role=treeitem]'); }
  else if (event.key === 'ArrowLeft') { if (folder && open) toggleFolder(item,false); else target = parent; }
  else if (event.key === 'Enter' || event.key === ' ') { if (folder) toggleFolder(item); else selectFile(item.dataset.path); }
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    treeSearch = (Date.now()-treeSearchTime > 700 ? '' : treeSearch) + event.key.toLowerCase(); treeSearchTime = Date.now();
    target = [...visible.slice(index+1),...visible.slice(0,index+1)].find(node => node.dataset.name.toLowerCase().startsWith(treeSearch));
  } else return;
  event.preventDefault(); if (target) focusTreeItem(target);
});
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('implementation-changes').addEventListener('click', () => setView('changes'));
$('implementation-ask').addEventListener('click', () => {
  if (state.busy) return;
  if ($('assistant-mode').querySelector('[value=codex]').disabled) return notice('Install Codex CLI to implement changes with Codex.');
  if (state.provider !== 'codex') { $('assistant-mode').value = 'codex'; $('assistant-mode').dispatchEvent(new Event('change')); }
  $('prompt').focus();
  if ($('agent-sidebar').hidden) togglePanel('agent');
});
$('live-patch-close').addEventListener('click', closeLivePatch);
$('follow-edits').addEventListener('change', () => { if ($('follow-edits').checked && lastPatchPath) showLivePatch(lastPatchPath); });
function togglePanel(panel) {
  const sidebar = $(panel === 'files' ? 'files-sidebar' : 'agent-sidebar');
  sidebar.hidden = !sidebar.hidden;
  document.querySelector('.workspace').classList.toggle(panel + '-collapsed', sidebar.hidden);
  $('toggle-' + panel).setAttribute('aria-expanded', String(!sidebar.hidden));
}
$('toggle-files').addEventListener('click', () => togglePanel('files'));
$('toggle-agent').addEventListener('click', () => togglePanel('agent'));
const narrowWorkspace = matchMedia('(max-width: 820px)');
narrowWorkspace.addEventListener('change', event => {
  if (event.matches && !$('files-sidebar').hidden) togglePanel('files');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const id of ['agent-settings']) {
    const disclosure = $(id);
    if (disclosure.open && disclosure.contains(document.activeElement)) {
      disclosure.open = false; disclosure.querySelector('summary').focus();
    }
  }
});
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (['map', 'archify', 'changes', 'implement', 'preview'].includes(view)) setView(view);
});
document.querySelectorAll('[data-detail]').forEach(b => b.addEventListener('click', () => setDetail(b.dataset.detail)));
document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => suggestedQuestion(b.dataset.prompt)));
$('explain-file').addEventListener('click', () => suggestedQuestion('explain'));
$('review-changes').addEventListener('click', () => suggestedQuestion('review'));
$('load-diff').addEventListener('click', loadDiff);
$('generate-diagram').addEventListener('click', generateDiagram);
$('source-save').addEventListener('click', saveSource);
$('source-reload').addEventListener('click', () => { if (editorSaving) return; drafts.delete(state.root + ':' + state.selected); loadSource(); });
$('source-expand').addEventListener('click', () => {
  const expanded = document.querySelector('.review-surface').classList.toggle('editor-expanded');
  $('source-expand').textContent = expanded ? 'Restore ↙' : 'Expand ↗';
  $('source-expand').setAttribute('aria-pressed', String(expanded)); sourceEditor.measure();
});
$('codex-model').addEventListener('change', () => { localStorage.setItem('qwen-review-codex-model:' + (codexAccount?.account_id || 'signed-out'), $('codex-model').value); syncCodexModel(); });
$('jev-enabled').addEventListener('change', () => localStorage.setItem('qwen-review-jev-enabled', String($('jev-enabled').checked)));
$('codex-account-refresh').addEventListener('click', () => refreshCodexAccount().catch(error => notice(error.message)));
$('codex-login').addEventListener('click', () => changeCodexAccount('login'));
$('codex-logout').addEventListener('click', () => changeCodexAccount('logout'));
window.addEventListener('focus', () => { if (state.token && state.provider === 'codex') refreshCodexAccount().catch(error => notice(error.message)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && state.provider === 'codex') refreshCodexAccount().catch(error => notice(error.message)); });
setInterval(() => { if (!document.hidden && state.token && state.provider === 'codex') refreshCodexAccount().catch(() => {}); }, 15000);
$('attach-image').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', async () => { await addImages([...$('image-input').files]); $('image-input').value = ''; });
$('prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addImages(files); }
});
window.addEventListener('beforeunload', event => { if (drafts.size) { event.preventDefault(); event.returnValue = ''; } });
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
$('chat-form').addEventListener('submit', e => { e.preventDefault(); submitPrompt(); });
$('prompt').addEventListener('input', () => {
  if ($('notice').textContent.startsWith('Unknown skill:')) notice();
  updateComposerMenu();
});
$('prompt').addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideComposerMenu(); return; }
  if (!$('composer-menu').hidden && composerChoices.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      composerChoice = (composerChoice + (e.key === 'ArrowDown' ? 1 : -1) + composerChoices.length) % composerChoices.length;
      $('composer-options').querySelectorAll('[role=option]').forEach((option, index) => option.setAttribute('aria-selected', String(index === composerChoice)));
      $('prompt').setAttribute('aria-activedescendant', 'composer-option-' + composerChoice);
      $('composer-option-' + composerChoice).scrollIntoView({block:'nearest'});
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composerChoices[composerChoice].run(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
});
document.addEventListener('click', event => { if (!$('chat-form').contains(event.target)) hideComposerMenu(); });
$('new-chat').addEventListener('click', newSession);
$('new-session').addEventListener('click', newSession);
$('resume-task').addEventListener('click', () => sendQuestion('Continue the interrupted task. Inspect the current files and recorded results first, and continue the original request without repeating completed actions.'));
$('full-access').addEventListener('change', () => localStorage.setItem('arko-full-access', String($('full-access').checked)));
async function resumeSession(selected) {
  if (state.busy || preparingRequest || accountAction) { renderSessions(); return; }
  hideComposerMenu();
  saveHistory();
  const session = codingSessions.find(session => session.id === selected);
  if (!session) return;
  activeSession = session.id; state.history = session.messages.slice();
  attachments = []; renderAttachments(); $('prompt').value = '';
  $('implementation-events').replaceChildren(element('li', 'Resumed session · ' + session.title));
  $('implementation-run-state').textContent = 'Ready';
  renderConversation();
  if (state.graph?.nodes.some(node => node.id === session.file)) await selectFile(session.file);
  saveHistory();
  $('prompt').focus();
}
$('coding-session').addEventListener('change', () => resumeSession($('coding-session').value));
async function stopRun() {
  state.stopRequested = true;
  if (!state.runId) return;
  try { await api('stop', { id: state.runId }); } catch (error) { notice(error.message); }
}
$('stop').addEventListener('click', stopRun);

(async function start() {
  try {
    const response = await fetch('/api/bootstrap');
    const bootstrap = await response.json();
    state.token = bootstrap.token;
    jevConfigured = Boolean(bootstrap.jev);
    $('full-access').checked = localStorage.getItem('arko-full-access') === null ? Boolean(bootstrap.full_access) : localStorage.getItem('arko-full-access') === 'true';
    $('jev-enabled').checked = jevConfigured && localStorage.getItem('qwen-review-jev-enabled') !== 'false';
    $('jev-enabled').disabled = !jevConfigured;
    $('full-access').disabled = false;
    $('jev-note').textContent = jevConfigured ? 'Shares requests, proposed actions and check results with OpenRouter.' : 'OpenRouter key required on this computer.';
    $('model-status').textContent = bootstrap.model;
    $('assistant-mode').querySelector('[value=codex]').disabled = !bootstrap.codex;
    await refreshCodexAccount();
    $('generate-diagram').disabled = !bootstrap.archify;
    const root = localStorage.getItem('qwen-review-project') || bootstrap.default_root;
    $('project-root').value = root;
    await openProject(root);
    const view = location.hash.slice(1);
    await setView(['map', 'archify', 'changes', 'implement', 'preview'].includes(view) ? view : 'implement');
    const provider = localStorage.getItem('qwen-review-provider') || bootstrap.default_provider || (view !== 'map' ? 'codex' : 'qwen');
    if (provider === 'codex' && bootstrap.codex && codexAccount?.signed_in) {
      $('assistant-mode').value = 'codex'; await switchAssistant();
    }
    state.ready = true;
    saveHistory();
    const pending = codingSessions.find(session => session.id === activeSession && session.runId);
    if (pending) {
      if (pending.file && state.graph.nodes.some(node => node.id === pending.file)) await selectFile(pending.file);
      sendQuestion(state.history.filter(message => message.role === 'user').at(-1)?.content || 'Continue task', pending);
    }
    if (narrowWorkspace.matches && !$('files-sidebar').hidden) togglePanel('files');
  } catch (error) { notice(error.message); }
})();
