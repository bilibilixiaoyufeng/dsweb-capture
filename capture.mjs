// DeepSeek 网页版对话抓取器
// 抓取自己的历史会话（含思考过程、分支树、图片/附件），导出为本地 JSON + 可选 Markdown。
//
// 用法：
//   node capture.mjs --limit 5        # 先抓 5 条试水
//   node capture.mjs --all            # 全量（断点续传）
//   node capture.mjs --session <id>   # 只抓一条
//   node capture.mjs --all --md       # 额外生成 transcript.md
//
// 首次运行会打开一个独立浏览器窗口让你登录；登录态保存在 ./.profile，之后免登录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://chat.deepseek.com';
const CDN = 'https://files.deepseeksvc.com/api';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const LIMIT = argOf('--limit') ? Number(argOf('--limit')) : null;
const ONLY_SESSION = argOf('--session');
const ALL = argv.includes('--all');
const WANT_MD = argv.includes('--md');
const CHANNEL = argOf('--channel') || 'msedge';
const OUT = path.resolve(process.cwd(), argOf('--out') || 'dsweb-exports');
// 登录态放在用户目录，不写进工具/skill 自身目录（避免被一起打包或提交）
const PROFILE = path.join(os.homedir(), '.dsweb-capture', 'profile');
const MANIFEST = path.join(OUT, 'manifest.jsonl');

if (argv.includes('--help') || (!ALL && !LIMIT && !ONLY_SESSION)) {
  console.log(`用法：
  node capture.mjs --all                 全量抓取（断点续传，已抓过的跳过）
  node capture.mjs --limit 5             只抓 5 条
  node capture.mjs --session <id>        只抓指定会话
  可选：--out <目录>   导出到指定目录（默认 ./dsweb-exports）
        --channel <msedge|chrome>   使用哪个已安装浏览器（默认 msedge）
        --md           额外生成 transcript.md`);
  process.exit(ALL || LIMIT || ONLY_SESSION ? 0 : 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
fs.mkdirSync(OUT, { recursive: true });

// ---------------- 断点续传 ----------------
function loadDone() {
  const done = new Set();
  if (!fs.existsSync(MANIFEST)) return done;
  for (const line of fs.readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.ok) done.add(o.id);
    } catch {
      /* 坏行忽略 */
    }
  }
  return done;
}
const appendManifest = (o) => fs.appendFileSync(MANIFEST, JSON.stringify(o) + '\n');

// ---------------- 登录态 ----------------
async function readToken(page) {
  try {
    return await page.evaluate(() => {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        const v = JSON.parse(raw);
        return typeof v === 'string' ? v : v?.value || v?.token || null;
      } catch {
        return raw;
      }
    });
  } catch {
    return null; // 页面跳转中
  }
}

// 依赖惰性加载：没有 node_modules 时 --help 仍然可用
let _chromium = null;
async function getChromium() {
  if (_chromium) return _chromium;
  try {
    ({ chromium: _chromium } = await import('playwright-core'));
  } catch {
    console.error(
      '\n✗ 缺少依赖 playwright-core。\n' +
        '  请在工具目录里执行：npm install\n' +
        `  工具目录：${HERE}\n`,
    );
    process.exit(3);
  }
  return _chromium;
}

async function launch(headless) {
  const chromium = await getChromium();
  return chromium.launchPersistentContext(PROFILE, {
    channel: CHANNEL,
    headless,
    viewport: { width: 1280, height: 860 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

log('启动浏览器…');
let ctx = await launch(true);
let page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
let token = await readToken(page);

if (!token) {
  log('未检测到登录态，打开浏览器窗口，请在窗口里登录 chat.deepseek.com（最多等 10 分钟）');
  await ctx.close();
  ctx = await launch(false);
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    token = await readToken(page);
    if (token) break;
  }
  if (!token) {
    log('✗ 10 分钟内没有完成登录，退出。');
    await ctx.close();
    process.exit(2);
  }
  log('登录成功，登录态已保存到 .profile，下次不用再登。');
}

const api = ctx.request;
const H = { Authorization: `Bearer ${token}` };

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await api.get(url, { headers: H, failOnStatusCode: false });
    const text = await r.text();
    if (r.status() === 429) {
      const wait = 5000 * (i + 1);
      log(`  429 限流，等待 ${wait}ms 后重试`);
      await sleep(wait);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status(), text, json };
  }
  return { status: 429, text: '', json: null };
}

// ---------------- 会话列表（游标分页） ----------------
async function listAllSessions() {
  const out = [];
  const seen = new Set();
  let url = `${BASE}/api/v0/chat_session/fetch_page?count=30`;
  let pageNo = 0;
  for (;;) {
    const r = await getJson(url);
    const d = r.json?.data?.biz_data ?? r.json?.data;
    if (!d?.chat_sessions) {
      log('列表接口异常：', r.status, String(r.text).slice(0, 160));
      break;
    }
    pageNo++;
    let added = 0;
    for (const s of d.chat_sessions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
      added++;
    }
    log(`列表第 ${pageNo} 页：${d.chat_sessions.length} 条（新增 ${added}，累计 ${out.length}，has_more=${d.has_more}）`);
    if (!d.has_more || added === 0) break;
    const last = d.chat_sessions[d.chat_sessions.length - 1];
    // 实测：游标是点号展开的两个查询参数，不是 JSON
    url = `${BASE}/api/v0/chat_session/fetch_page?lte_cursor.pinned=${last.pinned}&lte_cursor.updated_at=${last.updated_at}`;
    await sleep(600);
  }
  return out;
}

// ---------------- 单会话 ----------------
async function captureSession(s) {
  const dir = path.join(OUT, s.id);
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const hist = await getJson(`${BASE}/api/v0/chat/history_messages?chat_session_id=${s.id}`);
  if (!hist.json) throw new Error('历史接口失败 HTTP ' + hist.status);
  const d = hist.json.data?.biz_data ?? hist.json.data;
  const msgs = d.chat_messages || [];
  fs.writeFileSync(path.join(dir, 'conversation.json'), JSON.stringify(hist.json, null, 1));

  const fileIds = [];
  for (const m of msgs)
    for (const f of m.fragments || [])
      if (f.type === 'FILE') for (const x of f.files || []) if (x.id) fileIds.push(x.id);

  let downloaded = 0;
  let failed = 0;
  if (fileIds.length) {
    const q = fileIds.map((id) => `file_ids=${encodeURIComponent(id)}`).join('&');
    const fr = await getJson(`${BASE}/api/v0/file/fetch_files?${q}`);
    const files = fr.json?.data?.biz_data?.files || [];
    fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(fr.json, null, 1));
    for (const f of files) {
      if (!f.signed_path) continue;
      const ext = (path.extname(f.file_name || '').slice(1) || (f.is_image ? 'webp' : 'bin')).toLowerCase();
      const target = path.join(assets, `${f.id}.${ext}`);
      if (fs.existsSync(target) && fs.statSync(target).size > 0) {
        downloaded++;
        continue;
      }
      // 实测：图片用 ty=p（完整图），文档（docx/pdf）只有 ty=r 能拿到字节
      const u = `${CDN}${f.signed_path}&ty=${f.is_image ? 'p' : 'r'}`;
      const r = await api.get(u, { headers: { Referer: BASE + '/' }, failOnStatusCode: false });
      if (r.status() === 200) {
        const b = await r.body();
        if (b.length) {
          fs.writeFileSync(target, b);
          downloaded++;
        } else failed++;
      } else failed++;
      await sleep(120);
    }
  }

  const info = {
    id: s.id,
    title: s.title,
    updated_at: s.updated_at,
    pinned: s.pinned,
    model_type: s.model_type,
    title_type: s.title_type,
    messageCount: msgs.length,
    fileCount: fileIds.length,
    downloaded,
    failed,
    capturedAt: new Date().toISOString(),
    ok: true,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(info, null, 2));

  if (WANT_MD) {
    try {
      const { renderTranscript } = await import('./lib/transcript.mjs');
      const filesJson = fs.existsSync(path.join(dir, 'files.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'))
        : null;
      fs.writeFileSync(path.join(dir, 'transcript.md'), renderTranscript(dir, hist.json, filesJson));
    } catch (e) {
      log('  生成 Markdown 失败：' + String(e.message).split('\n')[0]);
    }
  }
  return info;
}

// ---------------- 主流程 ----------------
const done = loadDone();
log(`已完成 ${done.size} 条（断点续传）`);

let targets;
if (ONLY_SESSION) {
  targets = [{ id: ONLY_SESSION, title: ONLY_SESSION }];
} else {
  const all = await listAllSessions();
  fs.writeFileSync(
    path.join(OUT, 'sessions-index.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), total: all.length, sessions: all }, null, 1),
  );
  log(`会话总数：${all.length}`);
  targets = all.filter((s) => !done.has(s.id));
  if (LIMIT) targets = targets.slice(0, LIMIT);
  log(`本次待抓：${targets.length} 条`);
}

let ok = 0;
let fail = 0;
for (let i = 0; i < targets.length; i++) {
  const s = targets[i];
  const tag = `[${i + 1}/${targets.length}] ${String(s.title || s.id).slice(0, 28)}`;
  try {
    const info = await captureSession(s);
    appendManifest(info);
    ok++;
    log(`${tag} ✓ ${info.messageCount} 消息 / ${info.downloaded}/${info.fileCount} 附件`);
  } catch (e) {
    fail++;
    const brief = String(e.message || e).split('\n')[0].slice(0, 160);
    appendManifest({ id: s.id, ok: false, error: brief, when: new Date().toISOString() });
    log(`${tag} ✗ ${brief}`);
  }
  await sleep(700);
}

log(`\n完成：成功 ${ok}，失败 ${fail}。产物在 ${OUT}`);
await ctx.close();
