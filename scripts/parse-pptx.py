"""Read-only PPTX text/notes extraction. No Office execution or network access."""
import json, posixpath, re, sys, zipfile
from xml.etree import ElementTree as ET

NS = {'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
RID='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

def extract(path):
    with zipfile.ZipFile(path) as z:
        entries=z.infolist()
        if len(entries)>5000 or sum(x.file_size for x in entries)>160*1024*1024:
            raise ValueError('PPTX解压规模超限，请拆分课件。')
        if len({x.filename for x in entries})!=len(entries):
            raise ValueError('PPTX含重复条目。')
        names={x.filename for x in entries}
        def xml(name):
            if name not in names: return None
            info=z.getinfo(name)
            if info.file_size>5*1024*1024 or info.flag_bits&1:
                raise ValueError('PPTX XML过大或已加密。')
            raw=z.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError('不支持带DTD或实体声明的课件。')
            return ET.fromstring(raw)
        def relationships(base):
            folder, filename=posixpath.split(base)
            root=xml(folder+'/_rels/'+filename+'.rels')
            result={}
            if root is not None:
                for rel in root:
                    if rel.get('TargetMode')=='External': continue
                    target=rel.get('Target','')
                    resolved=posixpath.normpath(posixpath.join(folder,target)) if not target.startswith('/') else target.lstrip('/')
                    if resolved.startswith('../') or not resolved.startswith('ppt/'): continue
                    result[rel.get('Id')]=(resolved,rel.get('Type',''))
            return result
        presentation=xml('ppt/presentation.xml')
        if presentation is None: raise ValueError('不是可识别的PPTX；旧版PPT请先另存为PPTX。')
        links=relationships('ppt/presentation.xml')
        paths=[]
        for s in presentation.findall('.//p:sldId',NS):
            rel=links.get(s.get(RID))
            if rel and rel[1].endswith('/slide'): paths.append(rel[0])
        if not paths or len(paths)>400: raise ValueError('课件没有可识别页面，或超过400页。')
        def paragraphs(root):
            if root is None: return []
            return [''.join(t.text or '' for t in p.findall('.//a:t',NS)).strip()
                    for p in root.findall('.//a:p',NS) if ''.join(p.itertext()).strip()]
        slides=[]
        for number,path in enumerate(paths,1):
            root=xml(path)
            if root is None: raise ValueError('课件页面关系缺失。')
            texts=[p for p in paragraphs(root) if p]
            notes=[]
            for target,kind in relationships(path).values():
                if kind.endswith('/notesSlide'):
                    note=xml(target)
                    if note is not None:
                        for shape in note.findall('.//p:sp',NS):
                            ph=shape.find('.//p:ph',NS)
                            if ph is not None and ph.get('type') in ('sldNum','ftr','dt','hdr'): continue
                            notes.extend(p for p in paragraphs(shape) if p)
            slides.append({'slide':number,'title':texts[0][:160] if texts else f'第{number}页（无可提取文字）',
                           'text':'\n'.join(texts),'notes':'\n'.join(notes),
                           'imageCount':len(root.findall('.//p:pic',NS))})
        return {'kind':'pptx-text','slides':slides,'warnings':[
            '只提取文本、表格文字和备注；不解释图片、复杂图形、公式、动画或动作正确性。',
            '文本次序不保证等同视觉阅读次序，需教师按原页核对。']}

if __name__=='__main__':
    try:
        payload=extract(sys.argv[1])
        print(json.dumps(payload,ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=True))
        sys.exit(1)
