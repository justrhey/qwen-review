const $ = id => document.getElementById(id);
const folders = new Map([['.', {path:'.',files:[],children:[],open:true}]]);
for (const path of TREE_DATA.paths) {
  const parts = path.split('/'); parts.pop();
  let parent = '.';
  for (let i=0;i<parts.length;i++) {
    const name=parts.slice(0,i+1).join('/');
    if (!folders.has(name)) {folders.set(name,{path:name,files:[],children:[],open:false});folders.get(parent).children.push(name);}
    parent=name;
  }
  folders.get(parent).files.push(path);
}
for (const folder of folders.values()) folder.children.sort();
function count(path) {
  const folder=folders.get(path);folder.total=folder.files.length;
  for (const child of folder.children) folder.total+=count(child);
  return folder.total;
}
count('.');
$('title').textContent=TREE_DATA.name+' · Project tree';
$('counts').textContent=`${TREE_DATA.paths.length} scanned files · ${folders.size} folders · ${TREE_DATA.connections} parsed import connections`;
$('scope').textContent='Branches show folder structure. Import connections are available in Dependency map and selected-file Archify.';
$('scope').title=[TREE_DATA.scope,...TREE_DATA.warnings].join('\n');
let scale=1,offsetX=0,offsetY=0,bounds={width:340,height:66},query='';
const width=340,gap=48,levelGap=110;
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function measure(path) {
  const folder=folders.get(path);
  folder.height=66+(folder.open&&folder.files.length?24+Math.ceil(folder.files.length/2)*42-6:0);
  const children=folder.open?folder.children:[];
  const childWidth=children.reduce((total,child)=>total+measure(child),0)+Math.max(0,children.length-1)*gap;
  folder.width=Math.max(width,childWidth);return folder.width;
}
function render(fit=true) {
  const focused=document.activeElement?.dataset?.folder;
  measure('.');$('folders').replaceChildren();$('branches').replaceChildren();
  bounds={width:folders.get('.').width,height:0};
  function place(path,left,top) {
    const folder=folders.get(path),x=left+(folder.width-width)/2;
    folder.x=x;folder.y=top;bounds.height=Math.max(bounds.height,top+folder.height);
    const card=el('section',undefined,'folder');card.style.left=x+'px';card.style.top=top+'px';
    const toggle=el('button',undefined,'folder-toggle');toggle.dataset.folder=path;toggle.title=path==='.'?TREE_DATA.name:path;
    toggle.setAttribute('aria-expanded',String(folder.open));
    const name=el('span',undefined,'folder-name');name.append(el('strong',path==='.'?TREE_DATA.name:path.split('/').at(-1)),el('small',`${folder.total} files${folder.children.length?' · '+folder.children.length+' folders':''}`));
    toggle.append(el('span','▱','folder-icon'),name,el('span',folder.open?'−':'+','chevron'));
    toggle.addEventListener('click',()=>{folder.open=!folder.open;render();});card.append(toggle);
    if (folder.open&&folder.files.length) {
      const grid=el('div',undefined,'files');
      for(const path of folder.files){const file=el('span',path.split('/').at(-1),'file');file.tabIndex=0;file.title=path;if(query&&path.toLowerCase().includes(query))file.classList.add('match');grid.append(file);}
      card.append(grid);
    }
    if(query&&folder.path.toLowerCase().includes(query))card.classList.add('match');
    $('folders').append(card);
    if(!folder.open)return;
    const childTop=top+folder.height+levelGap;
    const childrenWidth=folder.children.reduce((sum,key)=>sum+folders.get(key).width,0)+Math.max(0,folder.children.length-1)*gap;
    let childLeft=left+(folder.width-childrenWidth)/2;
    for(const child of folder.children){
      place(child,childLeft,childTop);
      const childFolder=folders.get(child),startX=x+width/2,startY=top+folder.height,endX=childFolder.x+width/2,middleY=startY+levelGap/2;
      const branch=document.createElementNS('http://www.w3.org/2000/svg','path');
      branch.setAttribute('d',`M ${startX} ${startY} V ${middleY} H ${endX} V ${childTop}`);
      branch.setAttribute('fill','none');branch.setAttribute('stroke','#738193');branch.setAttribute('stroke-width','2');
      $('branches').append(branch);childLeft+=childFolder.width+gap;
    }
  }
  place('.',0,0);
  if(fit)fitTree();else camera();
  if(focused){const button=[...$('folders').querySelectorAll('button')].find(node=>node.dataset.folder===focused);button?.focus({preventScroll:true});}
}
function camera(){const transform=`translate(${offsetX}px,${offsetY}px) scale(${scale})`;$('folders').style.transform=transform;$('branches').style.transform=transform;$('zoom').textContent=Math.round(scale*100)+'%';}
function fitTree(){const rect=$('canvas').getBoundingClientRect();scale=Math.min(1,(rect.width-48)/bounds.width,(rect.height-48)/bounds.height);scale=Math.max(.005,scale);offsetX=(rect.width-bounds.width*scale)/2;offsetY=(rect.height-bounds.height*scale)/2;camera();}
function zoom(factor,x=$('canvas').clientWidth/2,y=$('canvas').clientHeight/2){const previous=scale;scale=Math.max(.005,Math.min(3,scale*factor));offsetX=x-(x-offsetX)*scale/previous;offsetY=y-(y-offsetY)*scale/previous;camera();}
$('fit').onclick=fitTree;$('in').onclick=()=>zoom(1.25);$('out').onclick=()=>zoom(.8);
$('expand').onclick=()=>{for(const folder of folders.values())folder.open=true;render();};
$('collapse').onclick=()=>{for(const folder of folders.values())folder.open=folder.path==='.';render();};
$('search').addEventListener('input',()=>{
  query=$('search').value.trim().toLowerCase();let matches=0;
  if(query){for(const folder of folders.values())folder.open=folder.path==='.';
    for(const [path,folder]of folders){if(path.toLowerCase().includes(query)||folder.files.some(file=>file.toLowerCase().includes(query))){matches++;folder.open=true;let parent=path;while(parent!=='.'){parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):'.';folders.get(parent).open=true;}}}
  }
  $('empty').hidden=!query||matches>0;render();
});
$('canvas').addEventListener('wheel',event=>{event.preventDefault();const rect=$('canvas').getBoundingClientRect();zoom(event.deltaY>0?.9:1.1,event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
let drag;
$('canvas').addEventListener('pointerdown',event=>{if(event.target.closest('.folder'))return;drag={x:event.clientX,y:event.clientY,offsetX,offsetY};$('canvas').setPointerCapture(event.pointerId);});
$('canvas').addEventListener('pointermove',event=>{if(drag){offsetX=drag.offsetX+event.clientX-drag.x;offsetY=drag.offsetY+event.clientY-drag.y;camera();}});
$('canvas').addEventListener('pointerup',()=>{drag=null;});$('canvas').addEventListener('pointercancel',()=>{drag=null;});
new ResizeObserver(fitTree).observe($('canvas'));render();

const presetNames = {classic:'Classic',flow:'Flow',blueprint:'Blueprint',editorial:'Editorial'};
function applyPreset(preset) {
  if (!presetNames[preset]) preset='classic';
  document.documentElement.dataset.preset=preset;
  $('preset-label').textContent=presetNames[preset]+' ⌄';
  for (const option of document.querySelectorAll('[data-preset-choice]')) option.setAttribute('aria-pressed',String(option.dataset.presetChoice===preset));
}
for (const option of document.querySelectorAll('[data-preset-choice]')) option.addEventListener('click',()=>{
  applyPreset(option.dataset.presetChoice);$('preset-picker').open=false;$('preset-label').focus();
});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#preset-picker'))$('preset-picker').open=false;});
$('preset-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){$('preset-picker').open=false;$('preset-label').focus();}});
function syncTheme() {
  const light=document.documentElement.dataset.theme==='light';
  $('theme').textContent=light?'☀ Light':'☾ Dark';$('theme').setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');
}
$('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';syncTheme();};
$('fullscreen').onclick=async()=>{
  try {if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch {$('scope').textContent='Fullscreen is unavailable in this browser. Download the HTML to open the tree in its own tab.';}
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen');});
$('export').onclick=()=>{
  const html='<!doctype html>\n'+document.documentElement.outerHTML;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  const link=el('a');link.href=url;link.download='project-tree.html';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
applyPreset(document.documentElement.dataset.preset);syncTheme();
