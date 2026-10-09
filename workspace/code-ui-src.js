import {EditorView, basicSetup} from 'codemirror';
import {EditorState} from '@codemirror/state';
import {keymap, Decoration, ViewPlugin, WidgetType} from '@codemirror/view';
import {indentWithTab} from '@codemirror/commands';
import {javascript} from '@codemirror/lang-javascript';
import {python} from '@codemirror/lang-python';
import {json} from '@codemirror/lang-json';
import {html} from '@codemirror/lang-html';
import {css} from '@codemirror/lang-css';
import {markdown} from '@codemirror/lang-markdown';
import {oneDark, oneDarkHighlightStyle} from '@codemirror/theme-one-dark';
import {highlightTree} from '@lezer/highlight';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

function language(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['js','jsx','mjs','cjs','ts','tsx','javascript','typescript'].includes(ext)) return javascript({typescript:['ts','tsx','typescript'].includes(ext),jsx:['jsx','tsx'].includes(ext)});
  if (['py','python'].includes(ext)) return python();
  if (ext === 'json') return json();
  if (['html','xml','svg'].includes(ext)) return html();
  if (['css','scss'].includes(ext)) return css();
  if (['md','markdown'].includes(ext)) return markdown();
  return null;
}

function createEditor(parent, onChange, onSave, options = {}) {
  let connections = [];
  const connectionMarks = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.mark(view); }
    update(update) { this.decorations = this.mark(update.view); }
    mark(view) {
      const ranges = [];
      for (const connection of connections) {
        if (connection.line < 1 || connection.line > view.state.doc.lines || !connection.specifier) continue;
        const line = view.state.doc.line(connection.line), offset = line.text.indexOf(connection.specifier);
        if (offset < 0) continue;
        ranges.push(Decoration.mark({class:'connection-underline', attributes:{style:'text-decoration-color:' + connection.color, title:connection.target}}).range(line.from + offset, line.from + offset + connection.specifier.length));
      }
      return Decoration.set(ranges, true);
    }
  }, {decorations:plugin=>plugin.decorations});
  class WritingCaret extends WidgetType {
    toDOM() { const caret = document.createElement('span'); caret.className = 'live-write-caret'; caret.setAttribute('aria-hidden', 'true'); return caret; }
  }
  const writingCaret = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.mark(view); }
    update(update) { this.decorations = this.mark(update.view); }
    mark(view) { return view.dom.dataset.writing ? Decoration.set([Decoration.widget({widget:new WritingCaret(),side:1}).range(view.state.selection.main.head)]) : Decoration.none; }
  }, {decorations:plugin=>plugin.decorations});
  const theme = EditorView.theme({
    '&': {height:'100%',backgroundColor:'#1e1e1e',fontSize:'13px'},
    '.cm-scroller': {fontFamily:'"Forge Mono",monospace',lineHeight:'1.7',overflow:'auto'},
    '.cm-content': {padding:'10px 0'},
    '.cm-gutters': {backgroundColor:'#1e1e1e',color:'#777',borderRight:'1px solid #ffffff0a'},
    '.cm-activeLine,.cm-activeLineGutter': {backgroundColor:'#ffffff05'},
    '.cm-focused': {outline:'none'}
  }, {dark:true});
  const diffLines = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.mark(view); }
    update(update) { if (update.docChanged) this.decorations = this.mark(update.view); }
    mark(view) {
      const ranges = [];
      for (let number = 1; number <= view.state.doc.lines; number++) {
        const line = view.state.doc.line(number);
        const kind = line.text.startsWith('+') ? 'added' : line.text.startsWith('-') ? 'removed' : line.text.startsWith('@@') ? 'hunk' : '';
        if (kind) ranges.push(Decoration.line({class:'live-diff-' + kind}).range(line.from));
      }
      return Decoration.set(ranges);
    }
  }, {decorations: plugin => plugin.decorations});
  const extensions = path => [basicSetup,theme,oneDark,connectionMarks,language(path) || [],
    ...(options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ...(options.diff ? [diffLines] : []),
    ...(options.typing ? [writingCaret] : []),
    keymap.of([indentWithTab,{key:'Mod-s',run:()=>{onSave();return true;}}]),
    EditorView.updateListener.of(update=>{if(update.docChanged || update.selectionSet)onChange(update.state.doc.toString(),update.state.doc.lineAt(update.state.selection.main.head));}),
    EditorView.contentAttributes.of({'aria-label':options.readOnly ? 'Live source code' : 'Source code editor',spellcheck:'false'})];
  const view = new EditorView({parent,state:EditorState.create({extensions:extensions('txt')})});
  let writingFrame = null, writingTarget = null, writingPromise = Promise.resolve(), resolveWriting = null;
  function cancelWriting() {
    if (writingFrame !== null) cancelAnimationFrame(writingFrame);
    writingFrame = null; writingTarget = null;
    delete view.dom.dataset.writing;
    view.dispatch({});
    if (resolveWriting) { resolveWriting(); resolveWriting = null; }
  }
  function write(text, follow = false) {
    if (writingTarget === text) return writingPromise;
    cancelWriting();
    const current = view.state.doc.toString();
    if (current === text) return Promise.resolve();
    let start = 0, end = current.length, targetEnd = text.length;
    while (start < end && start < targetEnd && current[start] === text[start]) start++;
    while (end > start && targetEnd > start && current[end - 1] === text[targetEnd - 1]) { end--; targetEnd--; }
    // Keep UTF-16 character boundaries intact when a changed character is an emoji.
    if (start && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
    if (targetEnd < text.length && /[\uDC00-\uDFFF]/.test(text[targetEnd])) { targetEnd++; end++; }
    const inserted = text.slice(start, targetEnd);
    if (document.hidden || matchMedia('(prefers-reduced-motion:reduce)').matches || !inserted.length) {
      view.dispatch({changes:{from:start,to:end,insert:inserted},selection:{anchor:start + inserted.length}});
      if (follow) view.dispatch({effects:EditorView.scrollIntoView(start + inserted.length,{y:'nearest'})});
      return Promise.resolve();
    }
    writingTarget = text;
    view.dom.dataset.writing = 'true';
    view.dispatch({changes:{from:start,to:end,insert:''},selection:{anchor:start}});
    writingPromise = new Promise(resolve=>{resolveWriting = resolve;});
    const duration = Math.min(1400, Math.max(160, inserted.length * 8));
    let began = null, written = 0;
    function step(time) {
      if (began === null) began = time;
      let count = Math.min(inserted.length, Math.max(written + 1, Math.floor((time - began) / duration * inserted.length)));
      if (count < inserted.length && /[\uD800-\uDBFF]/.test(inserted[count - 1])) count++;
      view.dispatch({changes:{from:start + written,insert:inserted.slice(written,count)},selection:{anchor:start + count}});
      written = count;
      if (follow) view.dispatch({effects:EditorView.scrollIntoView(start + count,{y:'nearest'})});
      if (written < inserted.length && !document.hidden) writingFrame = requestAnimationFrame(step);
      else {
        if (written < inserted.length) view.dispatch({changes:{from:start + written,insert:inserted.slice(written)}});
        cancelWriting();
      }
    }
    writingFrame = requestAnimationFrame(step);
    return writingPromise;
  }
  if (options.typing) document.addEventListener('visibilitychange', () => {
    if (!document.hidden || writingTarget === null) return;
    const text = writingTarget;
    cancelWriting();
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});
  });
  return {
    text:()=>view.state.doc.toString(),
    connections:items=>{connections = items; view.dispatch({});},
    write, cancelWriting, whenWritten:()=>writingPromise,
    update:(text,follow=false,line=0)=>{
      cancelWriting();
      const selection = view.state.selection.main;
      view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},selection:{anchor:Math.min(selection.anchor,text.length),head:Math.min(selection.head,text.length)}});
      if (follow) view.dispatch({effects:EditorView.scrollIntoView(line ? view.state.doc.line(Math.max(1,Math.min(line,view.state.doc.lines))).from : text.length,{y:'center'})});
    },
    set:(text,path,line=0)=>{
      cancelWriting();
      view.setState(EditorState.create({doc:text,extensions:extensions(path)}));
      view.requestMeasure();
      if(line){const target=view.state.doc.line(Math.max(1,Math.min(line,view.state.doc.lines)));view.dispatch({selection:{anchor:target.from},effects:EditorView.scrollIntoView(target.from,{y:'center'})});}
    },
    measure:()=>view.requestMeasure(),
    focus:()=>view.focus()
  };
}

function highlight(code, text, name) {
  const support = language(name);
  if (!support) return;
  const tree = support.language.parser.parse(text);
  code.replaceChildren();
  let cursor = 0;
  highlightTree(tree,oneDarkHighlightStyle,(from,to,classes)=>{
    code.append(document.createTextNode(text.slice(cursor,from)));
    const span=document.createElement('span');span.className=classes;span.textContent=text.slice(from,to);code.append(span);cursor=to;
  });
  code.append(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(node,text,resolveSource) {
  node.innerHTML=DOMPurify.sanitize(marked.parse(text,{breaks:false,gfm:true}),{
    FORBID_TAGS:['img','style','svg','math','iframe','form','input','textarea','button'],FORBID_ATTR:['style']
  });
  node.querySelectorAll('a').forEach(link=>{
    const href=link.getAttribute('href') || '';
    const source=resolveSource(href,link.textContent);
    if(source) link.replaceWith(source);
    else if(/^https?:\/\//i.test(href)){link.target='_blank';link.rel='noopener noreferrer';}
    else link.replaceWith(document.createTextNode(link.textContent));
  });
  node.querySelectorAll('p > code,li > code').forEach(code=>{
    const source=resolveSource('source:'+code.textContent,code.textContent);if(source)code.replaceWith(source);
  });
  node.querySelectorAll('pre > code').forEach(code=>{
    const pre=code.parentElement;
    const text=code.textContent;
    const name=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9) || 'text';
    highlight(code,text,name);
    const wrapper=document.createElement('div');wrapper.className='code-block';
    const bar=document.createElement('div');bar.className='code-block-heading';
    const label=document.createElement('span');label.textContent=name;
    const copy=document.createElement('button');copy.type='button';copy.textContent='Copy';copy.setAttribute('aria-label','Copy code');
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);copy.textContent='Copied';}catch{copy.textContent='Could not copy';}};
    bar.append(label,copy);pre.replaceWith(wrapper);wrapper.append(bar,pre);
  });
}

window.CodeUI={createEditor,renderMarkdown};
