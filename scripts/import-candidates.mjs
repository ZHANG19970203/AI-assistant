import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../lib/service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'data/import-candidates.json');
let payload;
try { payload = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, '')); }
catch (error) { console.error(`无法读取候选文件：${error.message}`); process.exit(1); }
const service = createService({ dbPath: process.env.DATABASE_PATH ? resolve(root, process.env.DATABASE_PATH) : resolve(root, 'data/companion.sqlite') });
try {
  const result = service.importCandidates('teacher', payload.documents);
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`导入失败：${error.message}`); process.exitCode = 1; }
finally { service.close(); }
