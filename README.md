# dsh-long-memory 超长记忆包

给 DSH（DeepSeek Harness）装的插件：**跨会话长期记忆 + 长文查找 + 聊天记录提取与精炼 + 上下文总结记录与翻阅**。
纯 JS（BM25 + 中文二元分词混合检索），零第三方依赖，数据全部落本机。

## 能力

- **长期记忆**：`memory_store / memory_search / memory_get / memory_list / memory_forget / memory_stats`
  - 中英混合检索、词组精确匹配（`"..."`）、tag/kind 过滤
  - 相似记忆自动合并（保留历史版本），软删可恢复、硬删进 trash.jsonl
  - importance≥4 的记忆每次会话开机自动注入上下文（可配）
- **长文查找**：`doc_ingest / doc_search / doc_read / doc_list`
  - 文件按行切块（可调块大小/重叠），块级检索带行号引用，跨块按行读原文
  - 内容未变自动跳过；聊天记录也能入这个索引（`chat_extract { ingest: true }`）
- **聊天记录提取与精炼**：`chat_list / chat_extract / chat_digest`
  - 读 DSH 会话投影缓存，逐轮取「用户提问 + 助手回复」，可按轮区间截取
  - `chat_digest` 产出确定性骨架（逐轮主旨、文件、命令、URL、结论信号句），
    语义级精炼由模型在骨架上完成后再 `memory_store` 入库
- **上下文总结（记录 + 翻阅）**：`summary_save / summary_list / summary_read`
  - 一大段活儿的进展总结带会话与轮次范围存档；最新总结自动注入提示词块，压缩/换会话后照样接得上
  - 账本可按会话/关键词翻阅；总结同时是 digest 记忆，`memory_search` 也能搜到
  - 不给正文时按会话轮次自动生成确定性骨架兜底
- **系统提示词注入 + Skill**：教 agent 何时存、何时查、怎么引用；`long-memory` skill 可手动/自动调用

## 工具一览（17 个）

| 工具 | 作用 |
| --- | --- |
| memory_store | 写入/更新记忆（自动去重合并） |
| memory_search | 混合检索记忆（tag:/kind:/"词组"） |
| memory_get / memory_list / memory_forget / memory_stats | 单条/列表/删除/统计 |
| memory_config | 配置（自动注入开关、数量、分块参数等），即改即生效 |
| doc_ingest | 长文件/文本切块建索引 |
| doc_search / doc_read / doc_list | 块级检索 / 按块或行读原文 / 列出文档 |
| chat_list / chat_extract / chat_digest | 列会话 / 提取逐轮原文 / 精炼骨架（可入库） |
| summary_save / summary_list / summary_read | 上下文总结存档 / 翻账本 / 读全文 |

## 安装（本机 desktop 版）

插件源码放到 `%APPDATA%\dsh-desktop\harness\plugins\dsh-long-memory\`，
并在 profile（`%APPDATA%\dsh-desktop\harness\profiles\web\package.json`）里注册：

1. `dependencies` 加 `"dsh-long-memory": "file:../../plugins/dsh-long-memory"`
2. `dsh.profile.bundles` 数组加 `"dsh-long-memory"`
3. 保证 `profiles\web\node_modules\dsh-long-memory\` 有插件拷贝（pnpm install 或直接复制）
4. 重启 DSH Desktop，会话里喊一句「memory_stats」验证

## 数据位置

```
$DSH_HOME/storages/dsh-long-memory/
├── memories.json      # 记忆库（原子写）
├── trash.jsonl        # 硬删回收站
├── config.json        # 运行配置
└── docs/              # 长文索引（index.json + 每文档一个 json）
```

整目录可备份/迁移。环境变量 `DSH_LONG_MEMORY_DIR` 可把数据挪到别处。

## 设计说明

- 检索内核在 `lib/search.js`：ASCII 词 + CJK 滑动二元分词，BM25(k1=1.4,b=0.75) + 词组命中加成
  + 覆盖率；记忆层叠加 importance / recency 小幅加成。
- 聊天数据来自 `storages/session_projcache/sessions/session-*.json`（DSH 自己的投影缓存），
  解析容错：坏文件跳过，不炸会话列表。
- 本插件刻意不内置 LLM 调用：提取/骨架是确定性的，精炼由 agent 完成——可见、可控、可改。
