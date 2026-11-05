export async function uploadLearningImage(file,{phase,chapterId,token,mode='new'}){
  if(!file?.size||file.size>5*1024*1024)throw new Error('请选择5 MB以内的PNG、JPG或WebP图片');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择PNG、JPG或WebP图片');
  const objectURL=URL.createObjectURL(file);
  try {const img=new Image();img.src=objectURL;await img.decode();if(img.naturalWidth*img.naturalHeight>40000000)throw new Error('图片尺寸过大，请选择4000万像素以内的图片');}catch{throw new Error('图片无法读取或尺寸过大，请重新选择');}finally{URL.revokeObjectURL(objectURL);}
  const query=new URLSearchParams({phase,...(chapterId?{chapterId}:{})});
  const response=await fetch(`/api/${token?'study':'lesson-flow'}/images?${query}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',...(token?{'x-study-token':token,'x-study-mode':mode}:{'x-demo-role':'teacher'})},body:file});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'图片提交失败');return result;
}
export function bindTeacherImages(root=document){root.querySelectorAll('img[data-lesson-image]:not([data-loaded])').forEach(async img=>{img.dataset.loaded='yes';try{const response=await fetch('/api/lesson-flow/images/'+encodeURIComponent(img.dataset.lessonImage),{headers:{'x-demo-role':'teacher'}});if(!response.ok)throw new Error();const url=URL.createObjectURL(await response.blob());if(!img.isConnected){URL.revokeObjectURL(url);return;}img.onload=img.onerror=()=>URL.revokeObjectURL(url);img.src=url;}catch{img.alt='图片暂时无法读取';}});}
