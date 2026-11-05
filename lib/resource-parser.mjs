import { inflateRawSync } from 'node:zlib';

function unzipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无法读取 Office 文件压缩目录。');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + size);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else { cursor += 46 + nameLength + extraLength + commentLength; continue; }
    entries.set(name, data.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlText(xml) {
  return xml.replace(/<w:tab\b[^>]*\/>|<a:br\b[^>]*\/>/g, ' ')
    .replace(/<\/(?:w:p|a:p|w:tr|a:row)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .split(/\n+/).map(s => s.trim()).filter(Boolean).join('\n');
}

export function extractResourceText(filename, buffer) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['txt', 'md', 'srt', 'vtt'].includes(ext)) return { content: buffer.toString('utf8').replace(/^\uFEFF/, '').trim(), status: 'extracted' };
  if (ext === 'docx' || ext === 'pptx') {
    try {
      const entries = unzipEntries(buffer);
      let content = '';
      if (ext === 'docx') content = xmlText(entries.get('word/document.xml') || '');
      else content = [...entries.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, xml]) => xmlText(xml)).join('\n\n');
      if (content.length >= 10) return { content, status: 'extracted' };
      return { content: '', status: 'needs_review' };
    } catch { return { content: '', status: 'needs_review' }; }
  }
  if (ext === 'pdf') return { content: '', status: 'needs_text' };
  return { content: '', status: 'media' };
}
