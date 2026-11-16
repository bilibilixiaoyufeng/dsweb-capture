// 补抓附件：图片用 ty=p，文档用 ty=r（实测：docx/pdf 只有 ty=r 能拿到字节）。
// 扫描导出目录，凡是 assets/ 里缺的文件就重新取签名并下载。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://chat.deepseek.com';
const CDN = 'https://files.deepseeksvc.com/api';
const PROFILE = path.join(os.homedir(), '.dsweb-capture', 'profile');

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
if (argv.includes('--help')) {
  console.log('用法：node fix-attachments.mjs [--out <目录>]\n补抓 assets/ 里缺失的附件。');
  process.exit(0);
}
const OUT = path.resolve(process.cwd(), argOf('--out') || 'dsweb-exports');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('✗ 缺少依赖 playwright-core，请先在本目录执行：npm install');
  process.exit(3);
}
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'msedge', headless: true });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const raw = await page.evaluate(() => localStorage.getItem('userToken'));
let token = null;
try {
  const v = JSON.parse(raw);
  token = typeof v === 'string' ? v : v?.value || v?.token || null;
} catch {
  token = raw;
}
if (!token) {
  console.error('✗ 未登录：请先运行 node capture.mjs --limit 1 完成一次登录。');
  await ctx.close();
  process.exit(2);
}
const api = ctx.request;
const H = { Authorization: `Bearer ${token}`, Referer: BASE + '/' };

let dirs = 0,
  tried = 0,
  okCount = 0,
  failCount = 0;
for (const d of fs.readdirSync(OUT)) {
  const fj = path.join(OUT, d, 'files.json');
  if (!fs.existsSync(fj)) continue;
  const assets = path.join(OUT, d, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  let files = [];
  try {
    files = JSON.parse(fs.readFileSync(fj, 'utf8'))?.data?.biz_data?.files || [];
  } catch {
    continue;
  }
  const missing = files.filter((f) => !fs.readdirSync(assets).some((n) => n.startsWith(f.id + '.')));
  if (!missing.length) continue;
  dirs++;
  const q = missing.map((f) => `file_ids=${encodeURIComponent(f.id)}`).join('&');
  const rr = await api.get(`${BASE}/api/v0/file/fetch_files?${q}`, { headers: H, failOnStatusCode: false });
  let fresh = [];
  try {
    fresh = (await rr.json()).data.biz_data.files || [];
  } catch {
    /* 忽略 */
  }
  for (const f of fresh) {
    if (!f.signed_path) continue;
    tried++;
    const ty = f.is_image ? 'p' : 'r';
    const r = await api.get(`${CDN}${f.signed_path}&ty=${ty}`, { headers: H, failOnStatusCode: false });
    const b = await r.body();
    if (r.status() === 200 && b.length) {
      const ext = (path.extname(f.file_name || '').slice(1) || (f.is_image ? 'webp' : 'bin')).toLowerCase();
      fs.writeFileSync(path.join(assets, `${f.id}.${ext}`), b);
      okCount++;
    } else {
      failCount++;
      console.log(`  ✗ ${d.slice(0, 8)} ${f.file_name} HTTP ${r.status()} ${b.length}B`);
    }
    await sleep(150);
  }
}
console.log(`\n处理目录 ${dirs} 个 / 尝试 ${tried} 个 / 成功 ${okCount} / 失败 ${failCount}`);
await ctx.close();
