import {chapterTree,flatChapters} from './chapter-tree.js';
import {openResourcePreview} from './resource-preview.js';

export function createChapterManager({getState,api,refresh,toast,esc,navigate}){
  let selected='',uploadKind=null,filter='all';const folded=new Set();
  const chapters=()=>getState().data?.chapters||[],resources=()=>getState().data?.resources||[];
  const kind=r=>['video','audio'].includes(r.kind)?r.kind:'document';
  const names={all:'全部',video:'视频',document:'文档',audio:'音频'};
  const accept={all:'.txt,.md,.srt,.vtt,.docx,.pptx,.pdf,.mp4,.webm,.mov,.m4v,.mp3,.m4a,.wav,.ogg',video:'.mp4,.webm,.mov,.m4v',document:'.txt,.md,.srt,.vtt,.docx,.pptx,.pdf',audio:'.mp3,.m4a,.wav,.ogg'};
  function treeRows(nodes,depth=0){return nodes.map(c=>{
    const count=resources().filter(r=>r.chapterId===c.id).length,open=!folded.has(c.id);
    return `<div class="chapter-branch"><div class="chapter-node ${depth===0?'root-node':''} ${selected===c.id?'is-selected':''}" style="--depth:${depth}">
      ${c.children.length?`<button type="button" class="tree-toggle" data-tree-toggle="${esc(c.id)}" aria-label="${open?'收起':'展开'}${esc(c.displayTitle)}" aria-expanded="${open}">${open?'⌄':'›'}</button>`:'<span class="tree-toggle-spacer"></span>'}
      <button type="button" class="tree-select" data-tree-select="${esc(c.id)}" ${selected===c.id?'aria-current="page"':''}><span class="tree-code">${esc(c.code)}</span><span>${esc(c.displayTitle)}</span></button>
      <span class="tree-count ${count?'has-material':''}" title="${count}项资料" aria-label="${count}项资料">${count}</span>
    </div>${c.children.length&&open?`<div class="chapter-children">${treeRows(c.children,depth+1)}</div>`:''}</div>`;
  }).join('');}
  function card(r){return `<article class="chapter-file"><div class="file-symbol ${kind(r)}" aria-hidden="true">${kind(r)==='video'?'▷':kind(r)==='audio'?'♫':'▤'}</div><div class="file-info"><button type="button" class="file-title" data-tree-preview="${esc(r.id)}">${esc(r.title)}</button><small>${names[kind(r)]} · ${Math.ceil(r.fileSize/1024)} KB · ${r.status==='approved'?'已审核':'待审核'}${r.audience==='teacher'?' · 仅教师':''}</small></div><div class="file-actions"><button type="button" class="btn outline small" data-tree-preview="${esc(r.id)}">查看</button>${r.status==='pending'?`<button type="button" class="btn small" data-tree-approve="${esc(r.id)}">审核</button>`:''}</div></article>`;}
  function page(){
    const tree=chapterTree(chapters()),flat=flatChapters(chapters());if(!flat.some(c=>c.id===selected))selected=flat.find(c=>!c.children.length)?.id||flat[0]?.id||'';
    const c=flat.find(c=>c.id===selected),files=resources().filter(r=>r.chapterId===selected),shown=files.filter(r=>filter==='all'||kind(r)===filter),path=[];let node=c;
    while(node){path.unshift(node.displayTitle);node=flat.find(x=>x.id===node.parentId);}
    return `<div class="chapter-page"><div class="chapter-page-heading"><h1>章节</h1><button type="button" class="btn outline small" data-tree-new="root">＋ 新增章节</button></div><div class="chapter-workspace">
      <aside class="chapter-directory"><div class="directory-toolbar"><button type="button" data-tree-new="sibling">⊕ 同级目录</button><button type="button" data-tree-new="child" ${c?'':'disabled'}>⊕ 子目录</button><button type="button" data-tree-collapse title="展开或收起全部目录">⇅</button></div><nav aria-label="课程章节目录" class="chapter-tree">${treeRows(tree)||'<p class="chapter-empty">暂无章节</p>'}</nav></aside>
      <section class="chapter-editor"><div class="chapter-content-head"><small>${path.map(esc).join(' / ')||'课程内容'}</small><div><h2>${c?esc(c.code+' '+c.displayTitle):'请选择章节'}</h2>${c?`<div class="doc-actions"><button type="button" class="btn outline small" data-tree-edit>编辑</button><button type="button" class="btn outline small" data-tree-settings>设置</button></div>`:''}</div></div>
      ${c?`<div class="chapter-content-tools">${[['video','▷'],['document','▤'],['audio','♫']].map(([k,icon])=>`<button type="button" data-tree-upload="${k}"><span aria-hidden="true">${icon}</span>添加${names[k]}</button>`).join('')}<button type="button" data-tree-engine><span aria-hidden="true">☑</span>练习与讨论</button></div>
      ${uploadKind?`<form id="tree-upload-form" class="chapter-upload"><div class="section-head"><h3>添加${names[uploadKind]==='全部'?'资料':names[uploadKind]}</h3><button type="button" class="text-button" data-tree-upload-close>收起</button></div><div class="field"><label>资料名称<input name="title" maxlength="160" placeholder="默认使用文件名"></label></div><div class="field"><label class="chapter-drop">拖入文件或点击选择<input name="file" type="file" accept="${accept[uploadKind]}" multiple required></label></div><button type="submit" class="btn">上传资料</button><p id="tree-upload-status" role="status"></p></form>`:''}
      <div class="chapter-file-heading"><div class="chapter-filters">${Object.keys(names).map(k=>`<button type="button" data-tree-filter="${k}" class="${filter===k?'active':''}">${names[k]}</button>`).join('')}</div><span>${shown.length} 项资料</span></div><div id="chapter-resource-list">${shown.map(card).join('')||`<div class="chapter-empty"><div class="empty-file-symbol">▤</div><p>${files.length?'暂无此类资料':'本节暂无资料'}</p><button type="button" class="btn outline" data-tree-upload="all">＋ 添加资料</button></div>`}</div>`:'<div class="chapter-empty">点击“新增章节”开始添加。</div>'}
      </section></div></div>`;
  }
  async function redraw(){await refresh();}
  function editor(mode){
    const current=chapters().find(c=>c.id===selected),isNew=['root','sibling','child'].includes(mode),parent=isNew?(mode==='child'?selected:mode==='sibling'?current?.parentId||'':''):current?.parentId||'';
    const flat=flatChapters(chapters()),self=flat.find(c=>c.id===selected),options=flat.filter(c=>isNew||!(c.id===selected||c.code.startsWith(self.code+'.')));
    const dialog=document.createElement('dialog');dialog.className='chapter-edit-dialog';
    const date=current?.releaseAt?new Date(Date.parse(current.releaseAt)+8*3600000).toISOString().slice(0,16):'';
    dialog.innerHTML=`<form><h2>${isNew?'新增目录':mode==='settings'?'章节设置':'编辑章节'}</h2><div class="field"><label>名称<input name="title" required maxlength="160" value="${isNew?'':esc(current.title)}" autofocus></label></div>${isNew||mode==='settings'?`<div class="field"><label>上级目录<select name="parentId"><option value="">顶级章节</option>${options.map(c=>`<option value="${esc(c.id)}" ${c.id===parent?'selected':''}>${'　'.repeat(c.depth)}${esc(c.code+' '+c.displayTitle)}</option>`).join('')}</select></label></div>`:''}${mode==='settings'?`<div class="field"><label>状态<select name="status"><option value="published" ${current.status==='published'?'selected':''}>已发布</option><option value="draft" ${current.status==='draft'?'selected':''}>草稿</option></select></label></div><div class="field"><label>开放时间（北京时间）<input type="datetime-local" name="releaseAt" value="${date}"></label></div>`:''}<p class="chapter-form-error" role="status"></p><div class="doc-actions"><button class="btn" type="submit">保存</button><button class="btn outline" type="button" data-close>取消</button></div></form>`;
    document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.showModal();
    dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const submit=dialog.querySelector('[type=submit]');submit.disabled=true;try{const values=Object.fromEntries(new FormData(e.currentTarget));if(isNew)values.publishNow=true;if(Object.hasOwn(values,'releaseAt'))values.releaseAt=values.releaseAt?values.releaseAt+':00+08:00':null;const r=await api(isNew?'/api/chapters':'/api/chapters/'+selected+'/update',values);selected=r.chapter.id;if(r.chapter.parentId)folded.delete(r.chapter.parentId);dialog.close();await redraw();toast(isNew?'目录已添加':'章节已保存');}catch(error){dialog.querySelector('[role=status]').textContent=error.message;}finally{submit.disabled=false;}};
  }
  function bind(){if(!document.querySelector('.chapter-workspace'))return;
    document.querySelectorAll('[data-tree-select]').forEach(b=>b.onclick=async()=>{selected=b.dataset.treeSelect;uploadKind=null;filter='all';await redraw();});
    document.querySelectorAll('[data-tree-toggle]').forEach(b=>b.onclick=async()=>{const id=b.dataset.treeToggle;folded.has(id)?folded.delete(id):folded.add(id);await redraw();});
    document.querySelector('[data-tree-collapse]').onclick=async()=>{const parents=flatChapters(chapters()).filter(c=>c.children.length);if(parents.every(c=>folded.has(c.id)))folded.clear();else parents.forEach(c=>folded.add(c.id));await redraw();};
    document.querySelectorAll('[data-tree-new]').forEach(b=>b.onclick=()=>editor(b.dataset.treeNew));
    document.querySelector('[data-tree-edit]')?.addEventListener('click',()=>editor('edit'));
    document.querySelector('[data-tree-settings]')?.addEventListener('click',()=>editor('settings'));
    document.querySelector('[data-tree-engine]')?.addEventListener('click',()=>navigate?.(selected));
    document.querySelectorAll('[data-tree-preview]').forEach(b=>b.onclick=()=>openResourcePreview(b.dataset.treePreview));
    document.querySelectorAll('[data-tree-filter]').forEach(b=>b.onclick=async()=>{filter=b.dataset.treeFilter;await redraw();});
    document.querySelectorAll('[data-tree-upload]').forEach(b=>b.onclick=async()=>{uploadKind=b.dataset.treeUpload;await redraw();document.querySelector('#tree-upload-form')?.scrollIntoView({block:'nearest'});});
    document.querySelector('[data-tree-upload-close]')?.addEventListener('click',async()=>{uploadKind=null;await redraw();});
    document.querySelectorAll('[data-tree-approve]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('/api/resources/'+b.dataset.treeApprove+'/approve',{});await redraw();toast('已审核');}catch(e){toast(e.message);b.disabled=false;}});
    const form=document.querySelector('#tree-upload-form');if(!form)return;
    const picker=form.querySelector('[name=file]'),drop=form.querySelector('.chapter-drop');drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragover');};drop.ondragleave=()=>drop.classList.remove('dragover');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragover');picker.files=e.dataTransfer.files;};
    form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]'),status=form.querySelector('[role=status]');button.disabled=true;const target=selected,allowed=accept[uploadKind].split(',');try{const values=new FormData(form),files=values.getAll('file');for(const file of files){if(!file.size)throw new Error('请选择文件');if(file.size>128*1024*1024)throw new Error('单文件最大128 MB');if(!allowed.includes('.'+file.name.split('.').pop().toLowerCase()))throw new Error('请选择对应类型的文件');}
      for(const [i,file] of files.entries()){status.textContent=`正在上传 ${i+1} / ${files.length}`;const r=await fetch('/api/resources/upload',{method:'POST',headers:{'x-demo-role':'teacher','Content-Type':'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-file-mime':file.type||'application/octet-stream','x-resource-meta':encodeURIComponent(JSON.stringify({title:(files.length===1?String(values.get('title')||'').trim()||file.name:file.name).slice(0,160),chapterId:target,audience:'student',sourceType:'course'}))},body:file});const data=await r.json();if(!r.ok)throw new Error(data.error||'上传失败');}uploadKind=null;filter='all';await redraw();toast('资料已上传');
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
  }
  return {page,bind,select:id=>{selected=id;folded.clear();}};
}
