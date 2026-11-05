let active=null;
export async function openResourcePreview(id){
  active?.close();
  const dialog=document.createElement('dialog'),controller=new AbortController();let objectURL='';
  dialog.className='resource-dialog';dialog.setAttribute('aria-labelledby','resource-preview-title');
  dialog.innerHTML='<div class="resource-dialog-head"><h2 id="resource-preview-title">资料预览</h2><button class="btn outline small" type="button">关闭</button></div><div class="resource-dialog-body" role="status">正在读取…</div>';
  document.body.append(dialog);active=dialog;const content=dialog.querySelector('.resource-dialog-body');
  dialog.querySelector('button').onclick=()=>dialog.close();
  dialog.onclose=()=>{controller.abort();if(objectURL)URL.revokeObjectURL(objectURL);dialog.remove();if(active===dialog)active=null;};
  dialog.showModal();
  try{
    const response=await fetch('/api/resources/'+encodeURIComponent(id)+'/preview',{headers:{'x-demo-role':'teacher'},signal:controller.signal});
    const r=await response.json();if(!response.ok)throw new Error(r.error||'无法读取资料');
    dialog.querySelector('h2').textContent=r.title;content.replaceChildren();
    if(!['video','audio'].includes(r.kind)&&!r.filename.toLowerCase().endsWith('.pdf')){
      const pre=document.createElement('pre');pre.textContent=r.content||'这份文件暂无可在线显示的正文。';content.append(pre);return;
    }
    content.textContent='正在读取文件…';
    const file=await fetch(r.fileUrl,{headers:{'x-demo-role':'teacher'},signal:controller.signal});
    if(!file.ok)throw new Error('文件读取失败，请重试');
    let blob=await file.blob();if(r.filename.toLowerCase().endsWith('.pdf'))blob=new Blob([blob],{type:'application/pdf'});
    objectURL=URL.createObjectURL(blob);const viewer=document.createElement(r.kind==='video'?'video':r.kind==='audio'?'audio':'iframe');
    viewer.src=objectURL;viewer.title=r.title;if(viewer.tagName==='IFRAME')viewer.src+='#toolbar=0';else{viewer.controls=true;viewer.preload='metadata';}
    content.replaceChildren(viewer);
  }catch(e){if(!controller.signal.aborted)content.textContent=e.message;}
}
