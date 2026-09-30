---
name: long-memory
description: 超长记忆包工作流：跨会话记忆存取与修正、长文档切块检索、聊天记录提取与精炼存档。用户说「记住/回忆上次/之前说过」、要求长文查找或聊天总结时使用。
---

# 超长记忆包（dsh-long-memory）工作流

你有一套跨会话记忆系统。数据在本机 `$DSH_HOME/storages/dsh-long-memory/`，
检索是 BM25 + 中文二元分词的混合打分，无需联网、无第三方依赖。

## 什么时候用什么

| 场景 | 工具链 |
| --- | --- |
| 用户问「上次/之前我们…」 | `memory_search` → 命中就引用（标 🧠(记忆库)），没命中直说 |
| 用户说「记住…/以后都…/别再…」 | 立刻 `memory_store`（preference/decision，importance≥4） |
| 重要结论、决定、教训 | `memory_store`（decision/lesson，importance≥4） |
| 长文件/大材料要查 | `doc_ingest` → `doc_search` → `doc_read`（引用带 doc_id+行号） |
| 聊天记录提取/总结/存档 | `chat_list` → `chat_extract`（可 ingest=true）→ `chat_digest` → 人工精炼后 `memory_store` |
| 盘点/清理记忆 | `memory_list` / `memory_stats` / `memory_forget` |

## 记忆写入规范

1. **自包含**：一条记忆 = 一句将来只看它就懂的话。带时间、对象、结论。
   - 差：「用 pnpm」；好：「本项目包管理器用 pnpm@10，不要用 npm/y」（2026-xx-xx 决定）
2. **分类**：fact（事实）/ decision（决定）/ preference（偏好）/ reference（引用资料位置）/
   digest（会话摘要）/ lesson（教训）/ note（默认）。
3. **重要度**：1-5。≥4 会开机自动注入每轮上下文，只放真正长期有效的；默认 3。
4. **标签**：`偏好`、`项目:xxx`、`session:<sessionId>` 之类，小写。检索时可用 `tag:xxx` 过滤。
5. **修正旧记忆**：直接 `memory_store` 写同主题的新内容，相似度达标会自动合并并保留旧版历史；
   完全过时的用 `memory_forget`（默认软删，`purge: true` 物理删）。
6. **去重**：默认开启（dedupeThreshold=0.72 相似即合并）。确实要并存多条时 `dedupe: false`。

## 长文查找规范

1. `doc_ingest { path }` 一次入索引（内容没变会跳过；变了自动重建）。
2. `doc_search { query }` 拿命中块（带 doc_id、行号范围、片段、相关度）。
3. `doc_read { doc_id, chunk }` 或 `doc_read { doc_id, from_line, to_line }` 读原文；
   overlap 重叠行按行号自动去重。
4. 引用格式：`（doc:<doc_id> L12-18）`。大文件别整读，先检索后精读。

## 聊天记录提取与精炼

1. `chat_list`：找目标会话（current 标记当前会话；session 参数接受 sessionId 或文件路径）。
2. `chat_extract { session, from_turn, to_turn }`：逐轮原文。
   - `ingest: true` 同时切块入长文索引 → 之后聊天内容也能 `doc_search`。
3. `chat_digest { session, store: true }`：确定性骨架（逐轮主旨、文件、命令、URL、结论信号句）。
4. **语义精炼由你完成**：在骨架上提炼 3~7 条结构化记忆（决定/事实/偏好/遗留 TODO），
   逐条 `memory_store`，tags 带 `session:<id>` 和 `digest`。骨架里的原文别照搬，去水提炼。

## 维护

- `memory_config`：改 autoInject（开机注入）、条数、重要度门槛、分块参数等，即改即生效。
- `memory_stats`：库大小、分类分布、热门标签、数据目录位置。
- 数据可直接备份/迁移：整个 `storages/dsh-long-memory/` 目录拷走即可。
