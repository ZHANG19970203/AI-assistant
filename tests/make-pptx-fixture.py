import sys, zipfile
from xml.sax.saxutils import escape
mode=sys.argv[2] if len(sys.argv)>2 else 'normal'
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>')
    z.writestr('ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>')
    for i,words in [(1,['核对证据','记录资料版本与章节，再说明支持判断的依据。']),(2,['观察动作','先记录身体节段、姿势和方向，再解释。'])]:
        body=''.join('<a:p><a:r><a:t>'+escape(t)+'</a:t></a:r></a:p>' for t in words)
        xml='<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'+body+'</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
        if mode=='dtd' and i==2: xml='<!DOCTYPE x [<!ENTITY bad "injected">]>'+xml
        z.writestr(f'ppt/slides/slide{i}.xml',xml)
    z.writestr('ppt/slides/_rels/slide2.xml.rels','<Relationships><Relationship Id="note1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>')
    z.writestr('ppt/notesSlides/notesSlide1.xml','<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>教师备注：区分观察与推断。</a:t></a:r></a:p></p:txBody></p:sp></p:notes>')
