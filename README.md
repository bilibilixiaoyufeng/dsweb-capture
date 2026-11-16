# dsweb-capture

把 **chat.deepseek.com** 的历史对话导出成本地文件——包括**思考过程、分支结构的完整树、图片与附件**。

> ⚠️ **只用于备份你自己的数据。** 见下面的《风险与边界》。

## 它导出什么

```
dsweb-exports/
├─ manifest.jsonl            每完成一条追加一行（断点续传用）
├─ sessions-index.json       全部会话的列表快照
└─ <会话 id>/
   ├─ conversation.json      原始响应：完整的消息树（含 parent_id、每轮思考过程、搜索引用）
   ├─ files.json             附件元数据（文件名、尺寸、签名路径）
   ├─ meta.json              摘要（标题、时间、消息数、附件下载结果）
   ├─ transcript.md          人读的 Markdown（可选，--md）
   └─ assets/                图片与附件原件
```

`conversation.json` 是**完整树**：DeepSeek 的「重新生成 / 编辑后重答」会产生兄弟节点，这些都在里面。`transcript.md` 只渲染当前路径，其他分支放在文末附录。

## 快速开始

```bash
npm install          # 只依赖 playwright-core
node capture.mjs --limit 5     # 先抓 5 条试水
node capture.mjs --all         # 全量（可随时中断，重跑自动续）
node capture.mjs --all --md    # 顺带生成 markdown
```

**首次运行**会打开一个独立浏览器窗口（用的是已安装的 Edge，不会额外下载浏览器），请在窗口里登录 chat.deepseek.com。登录态存在 `~/.dsweb-capture/profile`，之后不用再登。

常用参数：

| 参数 | 作用 |
|---|---|
| `--all` | 全量抓取，已抓过的跳过 |
| `--limit N` | 只抓 N 条 |
| `--session <id>` | 只抓指定会话 |
| `--out <目录>` | 导出目录，默认 `./dsweb-exports` |
| `--channel <msedge\|chrome>` | 用哪个已安装浏览器，默认 `msedge` |
| `--md` | 额外生成 `transcript.md` |

补抓此前失败的附件：

```bash
node fix-attachments.mjs
```

## 它是怎么做的（实测结论，不是猜的）

抓取器直接调用网页端自己在用的接口，不解析 DOM，所以改版不会让它失效：

| 用途 | 接口 |
|---|---|
| 会话列表 | `GET /api/v0/chat_session/fetch_page?count=30` |
| 翻页游标 | `?lte_cursor.pinned=<bool>&lte_cursor.updated_at=<float>`（**点号展开的两个参数**，不是 JSON） |
| 单会话全部消息 | `GET /api/v0/chat/history_messages?chat_session_id=<id>`，一次返回完整树 |
| 附件元数据 | `GET /api/v0/file/fetch_files?file_ids=a&file_ids=b`（**重复的普通参数**，不是数组） |
| 附件字节 | `https://files.deepseeksvc.com/api{签名路径}&ty=<p\|t\|r>` |

几个容易踩的点，已经处理掉了：

- 图片用 `ty=p`、文档用 `ty=r`；`ty=t` 是缩略图，`ty=r` 对图片反而不可用。
- `ty=p` 返回的是**缩放后的预览图**，尺寸与元数据里声明的原图尺寸不一致——如果下游要按元数据校验尺寸，会报损坏。
- 附件 URL 带签名，会过期；所以下载是**当场完成**，不是存个链接。
- 限流返回 429 时指数退避，默认每条会话之间间隔 0.7 秒。

## 风险与边界

- **这是你对自己账号数据的导出**。DeepSeek 用户协议 3.5(3) 禁止"以机器人、爬虫等方式抓取本服务内容"，自动化抓取存在账号被限制的风险（社区反馈以 429 限流为主）。请自行判断并承担。
- 抓取器**只读**：不发送任何消息、不修改、不删除任何会话。
- 全部数据**只写本地磁盘**，不上传、不中转、不经过第三方。
- 请自用。不要拿它去抓别人的账号，也不要把抓下来的数据再分发。

## 已知限制

- 只导出你自己登录账号的会话；分享链接的会话需要用 `--session` 配合分享页另行处理。
- 极长的会话（数千条消息）会慢一些，`conversation.json` 也很大。
- 图片下载的是**预览图**（`ty=p`），不是原图；需要原图请手动在网页端下载。
- 接口是网页端私有接口，没有稳定性承诺，DeepSeek 改版可能让它失效。

## 许可

MIT
