import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function pythonExecutable(){
  const bundled=join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  return process.env.PYTHON_BIN || (existsSync(bundled)?bundled:process.platform==='win32'?'python':'python3');
}
export function parsePptx(path){return new Promise((resolve,reject)=>{
  const child=spawn(pythonExecutable(),[fileURLToPath(new URL('../scripts/parse-pptx.py',import.meta.url)),path],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('课件解析超时，请拆分后重试。'));},20000);
  child.stdout.on('data',b=>{out+=b.toString();if(out.length>8e6){child.kill();reject(new Error('课件文本过多，请拆分。'));}});
  child.stderr.on('data',b=>{err+=b.toString().slice(0,500);});
  child.on('error',()=>{clearTimeout(timer);reject(new Error('PPTX解析需要Python 3。请安装或配置PYTHON_BIN。'));});
  child.on('close',code=>{clearTimeout(timer);try{const payload=JSON.parse(out);if(code||payload.error)throw Error(payload.error||'解析失败');resolve(payload);}catch(e){reject(new Error(e.message||err||'课件解析失败。'));}});
});}
