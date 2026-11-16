// 把一条导出的会话渲染成人可读的 Markdown（含思考过程折叠、图片引用、未导入分支附录）。
import fs from 'node:fs';
import path from 'node:path';

const fmtTime = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : '未知');

export function renderTranscript(dir, conv, files) {
  const biz = conv.data?.biz_data ?? conv.data;
  const session = biz.chat_session || {};
  const msgs = biz.chat_messages || [];
  const byId = new Map(msgs.map((m) => [m.message_id, m]));
  const children = new Map();
  for (const m of msgs) {
    if (!m.parent_id) continue;
    if (!children.has(m.parent_id)) children.set(m.parent_id, []);
    children.get(m.parent_id).push(m.message_id);
  }
  const fileById = new Map((files?.data?.biz_data?.files || []).map((f) => [f.id, f]));

  // 当前路径：从 current_message_id 沿 parent_id 回溯
  const pathIds = [];
  let cur = byId.get(session.current_message_id) || msgs[msgs.length - 1];
  const guard = new Set();
  while (cur && !guard.has(cur.message_id)) {
    guard.add(cur.message_id);
    pathIds.push(cur.message_id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  pathIds.reverse();
  const pathSet = new Set(pathIds);

  const assetOf = (fid) => {
    const d = path.join(dir, 'assets');
    if (!fs.existsSync(d)) return null;
    const n = fs.readdirSync(d).find((x) => x.startsWith(fid + '.'));
    return n ? `assets/${n}` : null;
  };

  const out = [];
  const rawTitle = (session.title || '未命名会话').split('\n')[0];
  out.push(`# ${rawTitle}`, '');
  out.push(
    `> 来源：chat.deepseek.com ｜ 更新于 ${fmtTime(session.updated_at)} ｜ 消息 ${msgs.length} 条 ｜ 当前路径 ${pathIds.length} 条`,
    '',
  );

  let turn = 0;
  let block = null;
  const flush = () => {
    if (!block || (!block.user.length && !block.assistant.length)) return;
    turn++;
    out.push(`## 第 ${turn} 轮`, '');
    for (const m of block.user) {
      out.push('**你**', '');
      for (const fr of m.fragments || []) {
        if (fr.type === 'REQUEST' && fr.content) out.push(fr.content.trim(), '');
        if (fr.type === 'FILE')
          for (const f of fr.files || []) {
            const meta = fileById.get(f.id) || f;
            const asset = assetOf(f.id);
            if (asset && meta.is_image !== false) out.push(`![${meta.file_name || f.id}](${asset})`, '');
            else if (asset) out.push(`📎 附件：${meta.file_name || f.id}（\`${asset}\`）`, '');
            else out.push(`📎 附件：${meta.file_name || f.id}（未下载）`, '');
          }
      }
    }
    for (const m of block.assistant) {
      const think = (m.fragments || []).filter((f) => f.type === 'THINK' && f.content);
      if (think.length) {
        out.push('<details><summary>🧠 思考过程</summary>', '');
        for (const t of think) {
          out.push(
            ...String(t.content)
              .trim()
              .split('\n')
              .map((l) => '> ' + l),
          );
          out.push('');
        }
        out.push('</details>', '');
      }
      for (const fr of m.fragments || []) {
        if (fr.type === 'RESPONSE' && fr.content) out.push(fr.content.trim(), '');
        if (fr.type === 'TOOL_SEARCH') {
          const qs = (fr.queries || []).map((q) => q.query).filter(Boolean);
          const rs = (fr.results || []).slice(0, 8);
          if (qs.length || rs.length) {
            out.push('<details><summary>🔎 联网搜索引用</summary>', '');
            if (qs.length) out.push(`查询：${qs.join('；')}`, '');
            for (const r of rs) out.push(`- [${r.title || r.url}](${r.url})`);
            out.push('', '</details>', '');
          }
        }
      }
    }
    out.push('---', '');
    block = null;
  };

  for (const id of pathIds) {
    const m = byId.get(id);
    if (!block) block = { user: [], assistant: [] };
    if (m.role === 'USER') {
      if (block.assistant.length) {
        flush();
        block = { user: [], assistant: [] };
      }
      block.user.push(m);
    } else if (m.role === 'ASSISTANT') {
      block.assistant.push(m);
    }
  }
  flush();

  const branches = [];
  for (const [pid, kids] of children) {
    if (kids.length < 2) continue;
    for (const k of kids.filter((x) => !pathSet.has(x))) {
      const m = byId.get(k);
      const text =
        (m.fragments || [])
          .filter((f) => f.type === 'REQUEST' || f.type === 'RESPONSE')
          .map((f) => f.content)
          .find(Boolean) || '';
      branches.push({ pid, role: m.role, at: fmtTime(m.inserted_at), text: String(text).trim().slice(0, 300) });
    }
  }
  if (branches.length) {
    out.push('## 附录：其他分支', '', `共 ${branches.length} 条分支消息（本 Markdown 只渲染当前路径）：`, '');
    branches.forEach((b, i) => {
      out.push(`${i + 1}. 节点 \`${b.pid}\` 的另一个分支（${b.role}，${b.at}）`, '');
      out.push('   > ' + b.text.split('\n').join('\n   > '), '');
    });
  }

  return out.join('\n');
}
