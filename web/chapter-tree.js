export function chapterTree(chapters){
  const byParent=new Map(),ids=new Set(chapters.map(c=>c.id));
  for(const c of chapters){const key=ids.has(c.parentId)?c.parentId:null;if(!byParent.has(key))byParent.set(key,[]);byParent.get(key).push(c);}
  const visit=(parent=null,prefix='',ancestors=[])=> (byParent.get(parent)||[]).sort((a,b)=>a.position-b.position||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).filter(c=>!ancestors.includes(c.id)).map((c,i)=>{
    const code=prefix?prefix+'.'+(i+1):String(i+1),displayTitle=c.title.replace(/^\d+(?:\.\d+)*\s+/,'');return {...c,code,displayTitle,children:visit(c.id,code,[...ancestors,c.id])};
  });return visit();
}
export const flatChapters=chapters=>{const flat=[];const visit=(nodes,depth=0)=>{for(const n of nodes){flat.push({...n,depth});visit(n.children,depth+1);}};visit(chapterTree(chapters));return flat;};
