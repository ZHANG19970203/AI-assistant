import {transcribeAudio} from './study-media.mjs';
import {AppError} from './service.mjs';
export function createVoiceInput(transcribe=transcribeAudio){
  const pending=new Set();
  return async function recognize(key,bytes,mime){
    if(!['audio/webm','audio/ogg','audio/mp4','audio/wav','audio/x-wav','video/webm'].includes(String(mime).split(';')[0]))throw new AppError(415,'VOICE_FORMAT','语音格式不支持，请使用新版浏览器。');
    if(!bytes.length)throw new AppError(400,'VOICE_EMPTY','没有录到声音，请重试。');
    if(pending.has(key)||pending.size>=4)throw new AppError(429,'VOICE_BUSY','语音正在识别，请稍后再试。');
    pending.add(key);
    try{
      const text=await transcribe(bytes,mime);
      if(typeof text!=='string'||!text.trim())throw new AppError(422,'VOICE_NO_SPEECH','未识别到语音，请靠近麦克风重新说一次。');
      if(text.length>20000)throw new AppError(422,'VOICE_TOO_LONG','识别内容过长，请分段输入。');
      return {text:text.trim()};
    }catch(e){
      if(e instanceof AppError)throw e;
      if(e.message==='ASR_NOT_CONFIGURED')throw new AppError(503,'VOICE_NOT_CONFIGURED','语音识别尚未配置，请联系教师。');
      throw new AppError(502,'VOICE_UNAVAILABLE','语音识别暂时不可用，请重试；也可以直接打字。');
    }finally{pending.delete(key);}
  };
}
