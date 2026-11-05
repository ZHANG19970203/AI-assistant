let active=null;
export const voiceInputActive=()=>!!active;
export function installVoiceInput({getContext,isBlocked=()=>false,onNavigate,getNavigationContext=getContext}){
  const attached=new WeakSet();let frame=0;
  const icon='<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 10v1a6 6 0 0 0 12 0v-1M12 17v4m-3 0h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  function scan(){
    frame=0;if(active&&!active.target.isConnected)active.dialog.close();
    for(const target of document.querySelectorAll('textarea,input:not([type]),input[type=text],input[type=search]')){
      if(attached.has(target)||target.closest('[data-no-voice]')||target.readOnly||target.disabled||!getContext())continue;
      const label=(target.getAttribute('aria-label')||target.labels?.[0]?.textContent||target.closest('.field')?.querySelector('label')?.textContent||target.closest('.material-box')?.querySelector('h4')?.textContent||target.placeholder||({content:'思考题作答',question:'我的问题',attempt:'初步想法'})[target.name]||'文字').trim().slice(0,40);
      const wrapper=document.createElement('div');wrapper.className='voice-field';target.before(wrapper);wrapper.append(target);
      const button=document.createElement('button');button.type='button';button.className='voice-trigger';button.title='语音输入';button.setAttribute('aria-label',label+'：语音输入');button.innerHTML=icon;wrapper.append(button);
      button.onclick=e=>{e.preventDefault();e.stopPropagation();if(!target.disabled&&!target.readOnly)open(target,label);};attached.add(target);
    }
  }
  function open(target,label,command=false){
    if(active)return;
    const context=command?getNavigationContext():getContext();if(!context){alert('请从学习邮件中的专属链接进入学生端。');return;}
    const dialog=document.createElement('dialog');dialog.className='voice-dialog';dialog.dataset.noVoice='true';dialog.setAttribute('aria-labelledby','voice-dialog-title');
    dialog.innerHTML='<h2 id="voice-dialog-title">语音输入</h2><p class="voice-target"></p><p class="voice-status" role="status" aria-live="polite">点击开始后说话，最长60秒。</p><p class="voice-notice">语音由硅基流动转成文字。</p><textarea class="voice-result" aria-label="识别文字" rows="5" hidden></textarea><div class="voice-actions"><button class="btn" type="button" data-voice-start>开始录音</button><button class="btn" type="button" data-voice-stop hidden>结束并识别</button><button class="btn" type="button" data-voice-insert hidden>填入文字</button><button class="btn outline" type="button" data-voice-retry hidden>重试识别</button><button class="btn outline" type="button" data-voice-cancel>取消</button></div>';
    document.body.append(dialog);dialog.querySelector('.voice-target').textContent=label;if(command){dialog.querySelector('h2').textContent='语音导航';dialog.querySelector('[data-voice-insert]').textContent='前往';}
    const status=dialog.querySelector('.voice-status'),start=dialog.querySelector('[data-voice-start]'),stop=dialog.querySelector('[data-voice-stop]'),insert=dialog.querySelector('[data-voice-insert]'),result=dialog.querySelector('.voice-result'),retry=dialog.querySelector('[data-voice-retry]');
    const session={target,dialog,stream:null,recorder:null,timer:null,cancelled:false,controller:null,blob:null,mime:'',original:target.value,start:target.selectionStart??target.value.length,end:target.selectionEnd??target.value.length};active=session;
    function release(){clearInterval(session.timer);session.timer=null;session.stream?.getTracks().forEach(t=>t.stop());}
    dialog.addEventListener('close',()=>{session.cancelled=true;session.controller?.abort();if(session.recorder?.state==='recording')session.recorder.stop();release();dialog.remove();if(active===session)active=null;});
    dialog.querySelector('[data-voice-cancel]').onclick=()=>dialog.close();
    async function recognize(){
      if(session.cancelled)return;start.hidden=true;stop.hidden=true;insert.hidden=true;retry.hidden=true;status.textContent='正在识别…';session.controller=new AbortController();
      const timeout=setTimeout(()=>session.controller.abort(),130000);
      try{
        const headers={'Content-Type':'application/octet-stream','x-audio-mime':session.mime,'x-voice-consent':'yes'};
        if(context.teacher)headers['x-demo-role']='teacher';else{headers['x-study-token']=context.token;headers['x-study-mode']=context.mode||'new';}
        const url=context.teacher?'/api/voice/transcribe':command?'/api/study/voice/navigate':'/api/study/voice/transcribe?phase='+encodeURIComponent(context.phase);
        const response=await fetch(url,{method:'POST',headers,body:session.blob,signal:session.controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'识别未完成，请重试');
        if(session.cancelled)return;result.value=data.text;result.hidden=false;insert.hidden=false;start.hidden=false;start.textContent='重新录音';status.textContent='可修改文字，再填入输入框。';start.onclick=record;if(command){const message=await onNavigate(data.text);if(message===true){dialog.close();return;}status.textContent=message;}
      }catch(e){if(!session.cancelled){status.textContent=e.name==='AbortError'?'识别超时，请重试。':e.message;start.hidden=false;start.textContent='重新录音';start.onclick=record;retry.hidden=false;}}
      finally{clearTimeout(timeout);}
    }
    async function record(){
      if(isBlocked()){status.textContent='请先结束当前课堂录音。';return;}
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){status.textContent='当前环境不支持语音输入，请使用新版浏览器并通过本机地址或HTTPS打开。';return;}
      result.hidden=true;insert.hidden=true;retry.hidden=true;start.disabled=true;status.textContent='等待麦克风授权…';
      try{
        const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw new Error('当前浏览器不支持录音格式，请更换新版浏览器。');
        const stream=await navigator.mediaDevices.getUserMedia({audio:true});if(session.cancelled){stream.getTracks().forEach(t=>t.stop());return;}
        session.stream=stream;session.mime=mime;const recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:64000}),chunks=[];session.recorder=recorder;
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recorder.onerror=()=>{session.cancelled=true;release();status.textContent='录音中断，请关闭后重试。';stop.hidden=true;};
        recorder.onstop=()=>{release();if(session.cancelled)return;session.blob=new Blob(chunks,{type:mime});if(!session.blob.size){status.textContent='未录到声音，请重试。';start.hidden=false;stop.hidden=true;return;}recognize();};
        recorder.start();let seconds=0;status.textContent='正在录音 · 0秒';start.hidden=true;stop.hidden=false;
        session.timer=setInterval(()=>{seconds++;status.textContent='正在录音 · '+seconds+'秒';if(seconds>=60&&recorder.state==='recording'){stop.disabled=true;recorder.stop();}},1000);
        stop.disabled=false;stop.onclick=()=>{stop.disabled=true;if(recorder.state==='recording')recorder.stop();};
      }catch(e){release();status.textContent=e.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器中允许使用麦克风。':e.name==='NotFoundError'?'未找到麦克风，请连接后重试。':e.message;}
      finally{start.disabled=false;}
    }
    insert.onclick=async()=>{
      if(command){try{const message=await onNavigate(result.value);if(message===true)dialog.close();else status.textContent=message;}catch(e){status.textContent=e.message;}return;}
      if(!target.isConnected||target.value!==session.original){status.textContent='原输入框已变化，请复制识别文字后重新填写。';return;}
      const text=result.value.trim();if(!text){status.textContent='识别文字为空，请重录或填写文字。';return;}
      const next=session.original.slice(0,session.start)+text+session.original.slice(session.end);
      if(target.maxLength>=0&&next.length>target.maxLength){status.textContent='超出输入框的'+target.maxLength+'字限制，请缩短识别文字。';return;}
      target.value=next;target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));dialog.close();target.focus();target.setSelectionRange(session.start+text.length,session.start+text.length);
    };
    start.onclick=record;retry.onclick=recognize;dialog.showModal();
  }
  if(onNavigate){const target=document.createElement('input');target.type='hidden';target.dataset.noVoice='true';document.body.append(target);const button=document.createElement('button');button.type='button';button.className='voice-navigator';button.innerHTML=icon+'<span>语音导航</span>';button.title='说出要打开的页面或任务';button.onclick=()=>open(target,'说出页面、阶段或任务名称',true);document.body.append(button);}
  const observer=new MutationObserver(()=>{if(!frame)frame=requestAnimationFrame(scan);});observer.observe(document.body,{childList:true,subtree:true});scan();
  window.addEventListener('pagehide',()=>active?.dialog.close());
  window.addEventListener('beforeunload',e=>{if(active){e.preventDefault();e.returnValue='';}});
}
