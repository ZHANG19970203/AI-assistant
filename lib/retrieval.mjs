const FILLERS = /请问|如何|什么|怎么|为什么|是否|可以|一个|一下|有关|关于|学习|老师|资料|知识|帮助|告诉|解释|分析|描述|进行|应该|需要|以及|还有|哪些|区别|区分/g;

export function tokenize(text) {
  const normalized = String(text).toLowerCase().replace(FILLERS, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ');
  const grams = new Set();
  for (const word of normalized.split(/\s+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(word)) { if (word.length >= 2) grams.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) grams.add(word.slice(i, i + 2));
  }
  return grams;
}

export function retrieve(question, documents) {
  const query = tokenize(question);
  if (!query.size) return [];
  const candidates = [];
  for (const doc of documents) {
    if (doc.status !== 'approved' || doc.sourceType !== 'course' || doc.audience !== 'student') continue;
    for (const excerpt of doc.content.split(/\n\s*\n/).filter(Boolean)) {
      const tokens = tokenize(excerpt);
      const overlap = [...query].filter(t => tokens.has(t));
      const coverage = overlap.length / query.size;
      if (overlap.length < 1 || coverage < 0.22) continue;
      candidates.push({ documentId: doc.id, title: doc.title, section: doc.section, version: doc.version, excerpt: excerpt.slice(0, 1300), score: coverage + overlap.length * 0.03 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));
  return candidates.slice(0, 3).map(({ score, ...citation }) => citation);
}
