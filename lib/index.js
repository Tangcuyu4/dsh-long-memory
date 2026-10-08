// ── dsh-long-memory 超长记忆包 ────────────────────────────────────────────────
// 跨会话长期记忆 + 长文分块检索 + 聊天记录提取/精炼。
// 纯 JS 混合检索（BM25 + CJK 二元分词 + 词组加成），零第三方依赖。
// 数据目录：$DSH_HOME/storages/dsh-long-memory（可用 DSH_LONG_MEMORY_DIR 覆盖）

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore, newId, nowIso } from './store.js'
import { SearchIndex, makeSnippet, textSim } from './search.js'
import { chunkText, sha256 } from './chunk.js'
import {
  digestTurns,
  extractTurns,
  listSessions,
  loadSession,
  renderDigestText,
  resolveProjectionDirs,
  resolveSession,
} from './chat.js'

export const name = 'dsh-long-memory'
export const version = '1.1.0'
export const inject = ['tools', 'systemPrompt', 'skills']

const SECTION_NAME = 'dsh-long-memory:usage'
const SECTION_ORDER = 128
const SUMMARY_TAG = 'ctx-summary'

const DEFAULT_CONFIG = {
  autoInject: true,
  autoInjectCount: 8,
  autoInjectMinImportance: 4,
  autoInjectMaxChars: 160,
  chatMaxCharsPerTurn: 6000,
  ingestChunkSize: 1200,
  ingestOverlap: 150,
  docSearchLimit: 8,
  memorySearchLimit: 8,
  chatListLimit: 30,
  dedupeThreshold: 0.72,
  summaryInject: true,
  summaryInjectCount: 2,
  summaryInjectMaxChars: 800,
}

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG)

function dataRoot() {
  if (process.env.DSH_LONG_MEMORY_DIR) return resolve(process.env.DSH_LONG_MEMORY_DIR)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-long-memory')
}

async function atomicWrite(file, content) {
  await mkdir(resolve(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function stripFrontmatter(text) {
  return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

function brief(record) {
  return {
    id: record.id,
    kind: record.kind,
    tags: record.tags,
    importance: record.importance,
    updated: record.updated,
    chars: record.text.length,
    preview: record.text.length > 120 ? `${record.text.slice(0, 120)}…` : record.text,
  }
}

function summaryBrief(record) {
  const meta = record.meta && typeof record.meta === 'object' ? record.meta : {}
  return {
    id: record.id,
    title: meta.title ?? record.text.split('\n')[0].slice(0, 60),
    sessionId: meta.sessionId ?? null,
    scope: meta.fromTurn != null || meta.toTurn != null ? `第${meta.fromTurn ?? 1}-${meta.toTurn ?? '?'}轮` : null,
    turns: meta.turns ?? null,
    chars: record.text.length,
    importance: record.importance,
    created: record.created,
    updated: record.updated,
    tags: record.tags,
    preview: record.text.length > 160 ? `${record.text.slice(0, 160)}…` : record.text,
  }
}

/** 从 exec/context 里挖 sessionId（各处结构会变，逐层兜底） */
function pickSessionId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const key of ['sessionId', 'sessionID', 'session_id']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v && typeof v === 'object' && typeof v.id === 'string' && v.id.trim()) return v.id.trim()
  }
  if (obj.header && typeof obj.header === 'object' && typeof obj.header.id === 'string' && obj.header.id.trim()) {
    return obj.header.id.trim()
  }
  for (const value of Object.values(obj)) {
    const hit = pickSessionId(value, depth + 1)
    if (hit) return hit
  }
  return null
}

function samePath(a, b) {
  try {
    const ra = resolve(a)
    const rb = resolve(b)
    return process.platform === 'win32'
      ? ra.toLowerCase() === rb.toLowerCase()
      : ra === rb
  } catch {
    return false
  }
}

const PROMPT_TEXT = `# 超长记忆包 (dsh-long-memory) — 工具使用守则
你拥有跨会话长期记忆与长文检索工具：memory_*（记忆库）、doc_*（长文检索）、chat_*（聊天记录提取与精炼）、summary_*（上下文总结记录与翻阅）。
1. 记忆优先：用户提「上次/之前/以前说过/我记得」类问题，先 memory_search 再回答；没查到就直说没记过，别编。
2. 即时记：用户说「记住/以后都/别再/默认就」→ 立刻 memory_store（kind: preference 或 decision，importance≥4）。
   内容写成自包含的一句话，别依赖上下文才能看懂。
3. 长文查找：文件或材料很长时先 doc_ingest 建索引，再 doc_search 定位、doc_read 精读；引用带上 doc_id 与行号。
4. 聊天存档：用户要「提取/总结/存档聊天」→ chat_list 找会话，chat_extract 取原文（可 ingest=true 入长文索引），
   chat_digest 拿确定性骨架，然后由你做语义精炼成 3~7 条结构化记忆逐条 memory_store（tags 带 session:<id>，kind: digest）。
5. 本节末尾列出的「重要记忆自动注入」（importance≥4）可直接使用；发现过时用 memory_store 写同主题新内容（自动合并覆盖旧条目）。
6. 回答用到了记忆，就在对应内容前标 🧠(记忆库)；记忆与现实冲突时，以现实为准并回写修正。
7. 上下文总结：一大段活儿干到关键节点、上下文快撑不住、或换会话接手前，把进展写成总结用 summary_save 记档（带轮次范围）；
   要翻旧账就 summary_list 看账本、summary_read 读全文。最新的总结会自动进本提示词块，干活前扫一眼就能接上上下文。`

export async function apply(ctx) {
  const root = dataRoot()
  const docsDir = join(root, 'docs')
  let config = { ...DEFAULT_CONFIG }
  try {
    config = { ...config, ...JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) }
  } catch {}

  const store = new MemoryStore(root)
  let memoryIndex = null
  let docIndex = null
  let registryCache = null
  const docCache = new Map()

  async function loadConfig2() {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }
  const saveCfg = async () => atomicWrite(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)

  // ── 记忆索引 ────────────────────────────────────────────────────────────────
  async function memoryIndexReady() {
    if (memoryIndex) return memoryIndex
    const index = new SearchIndex()
    for (const r of await store.records()) {
      if (r.deleted) continue
      index.add({
        id: r.id,
        text: `${r.kind} ${(r.tags || []).join(' ')} ${r.text}`,
        meta: { record: r, kind: r.kind, tags: r.tags, importance: r.importance, updated: r.updated },
      })
    }
    memoryIndex = index
    return index
  }
  const invalidateMemory = () => {
    memoryIndex = null
  }

  // ── 文档库 ─────────────────────────────────────────────────────────────────
  async function loadRegistry() {
    if (registryCache) return registryCache
    let raw = { version: 1, docs: {} }
    try {
      raw = JSON.parse(await readFile(join(docsDir, 'index.json'), 'utf8'))
    } catch {}
    registryCache = { docs: new Map(Object.entries(raw.docs && typeof raw.docs === 'object' ? raw.docs : {})) }
    return registryCache
  }
  async function saveRegistry(registry) {
    const obj = {}
    for (const [k, v] of registry.docs) obj[k] = v
    await atomicWrite(join(docsDir, 'index.json'), `${JSON.stringify({ version: 1, docs: obj }, null, 1)}\n`)
  }
  async function loadDoc(docId) {
    if (docCache.has(docId)) return docCache.get(docId)
    try {
      const doc = JSON.parse(await readFile(join(docsDir, `${docId}.json`), 'utf8'))
      if (doc && Array.isArray(doc.chunks)) {
        docCache.set(docId, doc)
        return doc
      }
    } catch {}
    return null
  }
  const invalidateDocs = () => {
    docIndex = null
    docCache.clear()
  }

  async function docIndexReady() {
    if (docIndex) return docIndex
    const registry = await loadRegistry()
    const index = new SearchIndex()
    for (const [docId, meta] of registry.docs) {
      const doc = await loadDoc(docId)
      if (!doc) continue
      for (const ch of doc.chunks) {
        index.add({
          id: `${docId}#${ch.index}`,
          text: ch.text,
          meta: {
            docId,
            title: meta.title ?? doc.title,
            path: meta.path ?? doc.path ?? null,
            chunkIndex: ch.index,
            startLine: ch.startLine,
            endLine: ch.endLine,
            tags: meta.tags ?? doc.tags ?? [],
          },
        })
      }
    }
    docIndex = index
    return index
  }

  /** 共享入库：按 sha256/path 去重，切块、落盘、更新注册表 */
  async function ingestText(text, { title, path = null, tags = [], chunkSize, overlap, mtime = null } = {}) {
    const registry = await loadRegistry()
    const hash = sha256(text)
    for (const meta of registry.docs.values()) {
      if (meta.sha256 === hash) {
        return { action: 'unchanged', doc_id: meta.docId, title: meta.title, chunks: meta.chunks, reason: '内容与已索引文档完全相同' }
      }
    }
    const existing = path ? [...registry.docs.values()].find((d) => d.path && samePath(d.path, path)) : null
    const size = Math.max(200, Number(chunkSize) || config.ingestChunkSize)
    const ov = Math.max(0, Number(overlap ?? config.ingestOverlap))
    const chunks = chunkText(text, { chunkSize: size, overlap: ov })
    if (!chunks.length) return { action: 'skipped', reason: '没有可索引的内容' }
    const docId = existing?.docId || newId('d')
    const finalTitle = String(title || (path ? basename(path) : String(text).slice(0, 40).replace(/\s+/g, ' ').trim()) || docId)
    const normTags = [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))]
    const doc = {
      docId,
      title: finalTitle,
      path,
      sha256: hash,
      size: text.length,
      mtime,
      chunkSize: size,
      overlap: ov,
      tags: normTags,
      ingestedAt: nowIso(),
      chunks,
    }
    await atomicWrite(join(docsDir, `${docId}.json`), `${JSON.stringify(doc)}\n`)
    registry.docs.set(docId, {
      docId,
      title: finalTitle,
      path,
      sha256: hash,
      size: text.length,
      mtime,
      chunks: chunks.length,
      tags: normTags,
      ingestedAt: doc.ingestedAt,
    })
    await saveRegistry(registry)
    invalidateDocs()
    return {
      action: existing ? 'rebuilt' : 'created',
      doc_id: docId,
      title: finalTitle,
      chunks: chunks.length,
      chars: text.length,
      lines: text.split('\n').length,
    }
  }

  // ── 工具面 ─────────────────────────────────────────────────────────────────
  const jsonOut = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  const tools = []

  tools.push({
    name: 'memory_store',
    description:
      '写入/更新一条跨会话长期记忆（事实、决定、偏好、教训、会话摘要）。tags 分类 + importance(1-5，≥4 开机自动注入)；与既有记忆高度相似时自动合并更新而非新增（dedupe=false 强制新建）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆内容：一段自包含、将来只看这条就懂的话。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，如 ["偏好","编辑器"] 或 ["session:session-xxxx"]' },
        kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'reference', 'digest', 'lesson', 'note'], description: '记忆类型，默认 note' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1-5，默认 3；≥4 会开机自动注入' },
        source: { type: 'string', description: '来源说明，默认 agent' },
        dedupe: { type: 'boolean', description: '默认 true：与高相似记忆自动合并' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, error: 'text 不能为空' }
      const tags = [...new Set((Array.isArray(args.tags) ? args.tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))]
      const kind = typeof args.kind === 'string' && args.kind ? args.kind : 'note'
      const importance = Math.min(5, Math.max(1, Math.round(Number(args.importance) || 3)))
      if (args.dedupe !== false) {
        const index = await memoryIndexReady()
        const candidates = index.search(text, { limit: 3 })
        for (const hit of candidates) {
          const old = hit.doc.meta.record
          const sim = textSim(old.text, text)
          if (sim >= (Number(config.dedupeThreshold) || 0.72)) {
            const updated = await store.update(old.id, { text, tags, importance, kind })
            invalidateMemory()
            return { ok: true, action: 'updated', merged_with: old.id, similarity: round2(sim), record: brief(updated) }
          }
        }
      }
      const record = await store.add({ text, tags, kind, importance, source: typeof args.source === 'string' && args.source ? args.source : 'agent' })
      invalidateMemory()
      return { ok: true, action: 'created', record: brief(record) }
    },
  })

  tools.push({
    name: 'memory_search',
    description:
      '混合检索长期记忆库（BM25 + 中文二元分词 + 词组加成 + 重要度/新鲜度加成）。支持 tag:xxx、kind:xxx 过滤和 "词组" 精确匹配。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，可混合 tag:/kind: 与 "词组"' },
        tag: { type: 'string', description: '按标签过滤（快捷方式）' },
        kind: { type: 'string', description: '按类型过滤' },
        limit: { type: 'integer', description: '返回条数，默认 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const index = await memoryIndexReady()
      let query = String(args.query ?? '')
      if (args.tag) query += ` tag:${args.tag}`
      if (args.kind) query += ` kind:${args.kind}`
      const hits = index.search(query, { limit: Math.min(50, Math.max(1, Math.round(Number(args.limit) || config.memorySearchLimit))) })
      return {
        ok: true,
        query,
        total: hits.length,
        hits: hits.map((h) => ({
          id: h.doc.meta.record.id,
          score: round2(h.score),
          coverage: round2(h.coverage),
          kind: h.doc.meta.kind,
          tags: h.doc.meta.tags,
          importance: h.doc.meta.importance,
          updated: h.doc.meta.updated,
          snippet: makeSnippet(h.doc.meta.record.text, h.matchedTerms, 200),
        })),
      }
    },
  })

  tools.push({
    name: 'memory_get',
    description: '按 id 读取一条记忆的完整内容（含历史版本）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const record = await store.get(String(args.id ?? ''))
      if (!record) return { ok: false, error: `记忆不存在: ${args.id}` }
      return { ok: true, record }
    },
  })

  tools.push({
    name: 'memory_list',
    description: '列出记忆（可按 tag/kind 过滤，按 updated/importance 排序），用于盘点记忆库。',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'integer' },
        order: { type: 'string', enum: ['updated', 'created', 'importance'] },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const rows = await store.list({
        tag: args.tag,
        kind: args.kind,
        limit: Math.min(200, Math.max(1, Math.round(Number(args.limit) || 30))),
        order: args.order,
      })
      return { ok: true, total: rows.length, records: rows.map(brief) }
    },
  })

  tools.push({
    name: 'memory_forget',
    description: '删除长期记忆：按 id 或 tag。默认软删（可查回），purge=true 物理删除进 trash.jsonl。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（与 tag 二选一）' },
        tag: { type: 'string', description: '按标签批量删' },
        purge: { type: 'boolean', description: 'true=物理删除，默认软删' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      if (!args.id && !args.tag) return { ok: false, error: 'id 和 tag 至少给一个' }
      const removed = args.purge ? await store.purge(args) : await store.forget(args)
      invalidateMemory()
      return { ok: true, mode: args.purge ? 'purge' : 'soft', removed: removed.map((r) => r.id) }
    },
  })

  tools.push({
    name: 'memory_stats',
    description: '记忆库统计：总数、分类分布、热门标签、数据目录与文件位置。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOut,
    async execute() {
      const stats = await store.stats()
      const registry = await loadRegistry()
      return {
        ok: true,
        ...stats,
        docs: registry.docs.size,
        summaries: (await store.list({ tag: SUMMARY_TAG, limit: 500 })).length,
        version,
        dataRoot: root,
        config,
      }
    },
  })

  tools.push({
    name: 'memory_config',
    description:
      '查看/修改超长记忆包配置：autoInject（开机自动注入重要记忆）、autoInjectCount、autoInjectMinImportance、autoInjectMaxChars、chatMaxCharsPerTurn、ingestChunkSize、ingestOverlap、memorySearchLimit、docSearchLimit、dedupeThreshold、summaryInject（上下文总结注入开关）、summaryInjectCount、summaryInjectMaxChars。写入 config.json。',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(CONFIG_KEYS.map((k) => [k, { type: ['boolean', 'integer', 'number'].includes(typeof DEFAULT_CONFIG[k]) ? (typeof DEFAULT_CONFIG[k] === 'boolean' ? 'boolean' : 'integer') : 'string' }])),
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      let changed = false
      for (const key of CONFIG_KEYS) {
        if (args[key] !== undefined && args[key] !== null) {
          config[key] = typeof DEFAULT_CONFIG[key] === 'boolean' ? Boolean(args[key]) : Number(args[key]) || DEFAULT_CONFIG[key]
          changed = true
        }
      }
      if (changed) await saveCfg()
      return { ok: true, changed, config, dataRoot: root, note: '配置即改即生效（下一次工具调用/提示词组装就用到）' }
    },
  })

  tools.push({
    name: 'doc_ingest',
    description:
      '把一个长文件（或直接给 text）切块建索引，供 doc_search 长文查找。内容未变时跳过；同路径重建覆盖。返回 doc_id 与块数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对，或相对会话工作区）' },
        text: { type: 'string', description: '直接给文本（与 path 二选一）' },
        title: { type: 'string', description: '文档标题，默认文件名或前 40 字' },
        chunk_size: { type: 'integer', description: '块大小（字符），默认 1200' },
        overlap: { type: 'integer', description: '块间重叠（字符），默认 150' },
        tags: { type: 'array', items: { type: 'string' }, description: '附加标签' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      let text = args.text != null ? String(args.text) : null
      let path = null
      let mtime = null
      if (args.path) {
        const cwd = exec?.agent?.session?.header?.cwd || process.cwd()
        path = isAbsolute(args.path) ? args.path : resolve(cwd, args.path)
        if (!existsSync(path)) return { ok: false, error: `文件不存在: ${path}` }
        text = await readFile(path, 'utf8')
        try {
          mtime = (await stat(path)).mtime.toISOString()
        } catch {}
      }
      if (!text || !text.trim()) return { ok: false, error: 'path 或 text 至少给一个' }
      const result = await ingestText(text, {
        title: args.title,
        path,
        tags: args.tags,
        chunkSize: args.chunk_size,
        overlap: args.overlap,
        mtime,
      })
      return { ok: result.action !== 'skipped', ...result }
    },
  })

  tools.push({
    name: 'doc_search',
    description:
      '在已索引长文档中检索（块级 BM25 + 二元分词），返回命中块、行号范围、片段与相关度；可按 doc_id/tag 过滤。引用时配合 doc_read。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，支持 "词组"' },
        doc_id: { type: 'string', description: '只在指定文档内检索' },
        tag: { type: 'string', description: '只检索带该标签的文档' },
        limit: { type: 'integer', description: '返回条数，默认 8' },
        window: { type: 'integer', description: '片段宽度（字符），默认 260' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const index = await docIndexReady()
      const registry = await loadRegistry()
      const wantTag = typeof args.tag === 'string' ? args.tag.toLowerCase() : null
      const filter = (doc) =>
        (!args.doc_id || doc.meta.docId === args.doc_id) && (!wantTag || (doc.meta.tags || []).includes(wantTag))
      const hits = index.search(String(args.query ?? ''), {
        limit: Math.min(30, Math.max(1, Math.round(Number(args.limit) || config.docSearchLimit))),
        filter,
      })
      const window = Math.max(80, Math.round(Number(args.window) || 260))
      return {
        ok: true,
        query: args.query,
        docsIndexed: registry.docs.size,
        total: hits.length,
        hits: hits.map((h) => ({
          doc_id: h.doc.meta.docId,
          title: h.doc.meta.title,
          chunk: h.doc.meta.chunkIndex,
          lines: `${h.doc.meta.startLine}-${h.doc.meta.endLine}`,
          score: round2(h.score),
          snippet: makeSnippet(h.doc.text, h.matchedTerms, window),
        })),
        hint: '用 doc_read 读整块/按行原文；引用注明 doc_id 与行号。',
      }
    },
  })

  tools.push({
    name: 'doc_read',
    description: '读取已索引文档原文：按块号读一块，或按行号范围跨块拼行（overlap 行自动去重），行号与 doc_search 一致。',
    parameters: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: '文档 id' },
        chunk: { type: 'integer', description: '块号（0 起）' },
        from_line: { type: 'integer', description: '起始行（1 起，含）' },
        to_line: { type: 'integer', description: '结束行（含）' },
      },
      required: ['doc_id'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const doc = await loadDoc(String(args.doc_id ?? ''))
      if (!doc) return { ok: false, error: `文档不存在: ${args.doc_id}`, hint: '用 doc_list 查看已索引文档' }
      if (Number.isInteger(args.chunk)) {
        const ch = doc.chunks[args.chunk]
        if (!ch) return { ok: false, error: `块号越界，有效范围 0..${doc.chunks.length - 1}` }
        return { ok: true, doc_id: doc.docId, title: doc.title, chunk: ch.index, lines: `${ch.startLine}-${ch.endLine}`, text: ch.text }
      }
      const registry = (await loadRegistry()).docs.get(doc.docId) ?? {}
      const maxLine = doc.chunks.length ? doc.chunks[doc.chunks.length - 1].endLine : 0
      const from = Math.max(1, Math.round(Number(args.from_line) || 1))
      const to = Math.min(maxLine, Math.round(Number(args.to_line) || Math.min(from + 199, maxLine)))
      if (from > to) return { ok: false, error: `行区间无效（文档共 ${maxLine} 行）` }
      const seen = new Set()
      const out = []
      for (const ch of doc.chunks) {
        if (ch.endLine < from || ch.startLine > to) continue
        const lines = ch.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const no = ch.startLine + i
          if (no < from || no > to || seen.has(no)) continue
          seen.add(no)
          out.push(`${no}| ${lines[i]}`)
        }
      }
      return {
        ok: true,
        doc_id: doc.docId,
        title: doc.title,
        path: doc.path ?? registry.path ?? null,
        from,
        to,
        text: out.join('\n'),
      }
    },
  })

  tools.push({
    name: 'doc_list',
    description: '列出已索引的长文档（doc_id、标题、来源路径、块数、标签、入库时间）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOut,
    async execute() {
      const registry = await loadRegistry()
      return {
        ok: true,
        total: registry.docs.size,
        docs: [...registry.docs.values()].sort((a, b) => String(b.ingestedAt).localeCompare(String(a.ingestedAt))),
      }
    },
  })

  tools.push({
    name: 'chat_list',
    description:
      '列出本机 DSH 会话（读会话投影缓存）：sessionId、轮数、最后活跃时间、首轮提问预览；current 标记当前会话。聊天记录提取的第一步。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '返回条数，默认 30' } },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      const dirs = resolveProjectionDirs()
      const currentId = exec?.agent?.session?.header?.id ?? exec?.sessionId ?? null
      const sessions = await listSessions(dirs, { limit: Math.min(100, Math.max(1, Math.round(Number(args.limit) || config.chatListLimit))) })
      return {
        ok: true,
        current,
        currentId,
        sessions: sessions.map((s) => ({ ...s, current: currentId ? s.sessionId.toLowerCase().includes(String(currentId).toLowerCase()) : false })),
      }
    },
  })

  tools.push({
    name: 'chat_extract',
    description:
      '提取一个 DSH 会话的逐轮对话原文（用户提问 + 助手回复），可按轮号区间截取；ingest=true 同时切块入长文索引，之后可 doc_search 检索聊天内容。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId / 文件路径 / 留空或 "current" 表示当前会话' },
        from_turn: { type: 'integer' },
        to_turn: { type: 'integer' },
        max_chars: { type: 'integer', description: '每轮 prompt/response 最大字符数，默认 6000' },
        ingest: { type: 'boolean', description: '同时索引进文档库' },
        tags: { type: 'array', items: { type: 'string' }, description: '入库时附加的标签' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      const currentId = exec?.agent?.session?.header?.id ?? exec?.sessionId ?? null
      const found = await resolveSession(args.session, { dirs: resolveProjectionDirs(), currentId })
      if (!found) return { ok: false, error: '找不到会话；先用 chat_list 列出，或传 sessionId/文件路径' }
      const parsed = await loadSession(found.file)
      const turns = extractTurns(parsed, {
        from: args.from_turn,
        to: args.to_turn,
        maxChars: Math.max(200, Math.round(Number(args.max_chars) || config.chatMaxCharsPerTurn)),
      })
      const out = {
        ok: true,
        session: found.sessionId,
        file: found.file,
        totalTurns: parsed.turns.length,
        returnedTurns: turns.length,
        turns,
      }
      if (args.ingest) {
        const text = turns.map((t) => `## 第 ${t.turn} 轮\n【用户】${t.prompt}\n【助手】${t.response}`).join('\n\n')
        out.ingested = await ingestText(text, {
          title: `chat:${found.sessionId}`,
          tags: ['chat', `session:${found.sessionId}`, ...(Array.isArray(args.tags) ? args.tags : [])],
        })
      }
      return out
    },
  })

  tools.push({
    name: 'chat_digest',
    description:
      '对一个会话生成确定性精炼骨架：逐轮主旨、提到的文件/命令/URL、结论信号句；store=true 时把骨架存为 digest 记忆（importance 默认 4）。语义级精炼由你在骨架上完成后用 memory_store 保存。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId / 文件路径 / "current"' },
        from_turn: { type: 'integer' },
        to_turn: { type: 'integer' },
        max_chars: { type: 'integer' },
        store: { type: 'boolean', description: '把骨架摘要存进记忆库' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'integer', minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      const currentId = exec?.agent?.session?.header?.id ?? exec?.sessionId ?? null
      const found = await resolveSession(args.session, { dirs: resolveProjectionDirs(), currentId })
      if (!found) return { ok: false, error: '找不到会话；先用 chat_list 列出' }
      const parsed = await loadSession(found.file)
      const turns = extractTurns(parsed, {
        from: args.from_turn,
        to: args.to_turn,
        maxChars: Math.max(200, Math.round(Number(args.max_chars) || config.chatMaxCharsPerTurn)),
      })
      const digest = digestTurns(turns)
      const out = { ok: true, session: found.sessionId, ...digest }
      if (args.store) {
        const text = renderDigestText(found.sessionId, digest)
        const record = await store.add({
          text,
          kind: 'digest',
          tags: ['digest', `session:${found.sessionId}`, ...(Array.isArray(args.tags) ? args.tags.map((t) => String(t).toLowerCase()) : [])],
          importance: Math.min(5, Math.max(1, Math.round(Number(args.importance) || 4))),
          source: 'chat-digest',
        })
        invalidateMemory()
        out.stored = brief(record)
      }
      return out
    },
  })

  // ── 上下文总结（记录 + 翻阅）─────────────────────────────────────────────────
  tools.push({
    name: 'summary_save',
    description:
      '上下文总结存档（记录）：把一段「上下文总结」存进长记忆（kind=digest、tag=ctx-summary），带会话与轮次范围元数据；最新的总结会自动注入长记忆提示词块，供接续上下文与翻阅。总结正文由你写；不给 summary 时按会话轮次自动生成确定性骨架兜底。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '总结正文：一段自包含的进展/结论/待办（要点分行写）；留空则自动生成骨架摘要' },
        session: { type: 'string', description: '总结覆盖的会话：sessionId / 文件路径 / "current"（默认当前会话）' },
        from_turn: { type: 'integer', description: '覆盖起始轮（1 起，含）' },
        to_turn: { type: 'integer', description: '覆盖结束轮（含）' },
        title: { type: 'string', description: '一句话标题，默认取正文首行' },
        tags: { type: 'array', items: { type: 'string' }, description: '附加标签' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1-5，默认 3（不动自动注入）' },
        store: { type: 'boolean', description: '默认 true 存档；false 只生成不存' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      const currentId = exec?.agent?.session?.header?.id ?? exec?.sessionId ?? pickSessionId(exec) ?? null
      let text = typeof args.summary === 'string' ? args.summary.trim() : ''
      const found = await resolveSession(args.session, { dirs: resolveProjectionDirs(), currentId })
      const meta = {}
      if (found) {
        meta.sessionId = found.sessionId
        try {
          meta.turns = (await loadSession(found.file)).turns.length
        } catch {}
      }
      if (args.from_turn != null && Number.isFinite(Number(args.from_turn))) meta.fromTurn = Math.max(1, Math.round(Number(args.from_turn)))
      if (args.to_turn != null && Number.isFinite(Number(args.to_turn))) meta.toTurn = Math.max(1, Math.round(Number(args.to_turn)))
      let skeletonUsed = false
      if (!text) {
        if (!found) return { ok: false, error: 'summary 为空又找不到会话，没法自动生成；直接给 summary 正文吧' }
        const parsed = await loadSession(found.file)
        const turns = extractTurns(parsed, {
          from: args.from_turn,
          to: args.to_turn,
          maxChars: Math.max(200, Math.round(Number(config.chatMaxCharsPerTurn) || 6000)),
        })
        if (!turns.length) return { ok: false, error: '会话里没捞着可总结的轮次' }
        text = renderDigestText(found.sessionId, digestTurns(turns))
        skeletonUsed = true
        if (meta.fromTurn == null) meta.fromTurn = turns[0].turn
        if (meta.toTurn == null) meta.toTurn = turns[turns.length - 1].turn
      }
      meta.title = String(args.title ?? '').trim() || text.split('\n')[0].slice(0, 60)
      if (args.store === false) {
        return { ok: true, stored: false, skeletonUsed, title: meta.title, chars: text.length, summary: text }
      }
      const record = await store.add({
        text,
        kind: 'digest',
        tags: [
          SUMMARY_TAG,
          'digest',
          ...(found ? [`session:${found.sessionId.toLowerCase()}`] : []),
          ...(Array.isArray(args.tags) ? args.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : []),
        ],
        importance: Math.min(5, Math.max(1, Math.round(Number(args.importance) || 3))),
        source: 'summary-save',
        meta,
      })
      invalidateMemory()
      return { ok: true, stored: true, skeletonUsed, record: summaryBrief(record), hint: '翻账本用 summary_list，读全文用 summary_read' }
    },
  })

  tools.push({
    name: 'summary_list',
    description: '翻阅上下文总结账本：按时间倒序列出已存档的总结（标题、会话、轮次范围、日期、长度、预览），可按会话/关键词过滤。',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '只看某会话的总结（id 片段 / 文件路径 / "current"）' },
        query: { type: 'string', description: '按标题/正文关键词过滤' },
        limit: { type: 'integer', description: '返回条数，默认 20' },
      },
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}, exec) {
      const currentId = exec?.agent?.session?.header?.id ?? exec?.sessionId ?? pickSessionId(exec) ?? null
      let rows = await store.list({ tag: SUMMARY_TAG, order: 'created', limit: 200 })
      if (args.session) {
        const found = await resolveSession(args.session, { dirs: resolveProjectionDirs(), currentId })
        const needle = (found?.sessionId ?? String(args.session)).toLowerCase()
        rows = rows.filter((r) => String(r.meta?.sessionId ?? '').toLowerCase().includes(needle))
      }
      const q = String(args.query ?? '').trim().toLowerCase()
      if (q) rows = rows.filter((r) => `${r.meta?.title ?? ''} ${r.text}`.toLowerCase().includes(q))
      const limit = Math.min(100, Math.max(1, Math.round(Number(args.limit) || 20)))
      return {
        ok: true,
        total: rows.length,
        summaries: rows.slice(0, limit).map(summaryBrief),
        hint: '用 summary_read { id } 读全文；总结同时是 digest 记忆，memory_search 也能搜到。',
      }
    },
  })

  tools.push({
    name: 'summary_read',
    description: '翻阅一条上下文总结全文（按 summary_list 给的 id）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '总结 id（summary_list 返回）' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: jsonOut,
    async execute(args = {}) {
      const record = await store.get(String(args.id ?? ''))
      if (!record || record.deleted) return { ok: false, error: `总结不存在: ${args.id}`, hint: '用 summary_list 看账本' }
      return {
        ok: true,
        summary: summaryBrief(record),
        text: record.text,
        isSummary: (record.tags || []).includes(SUMMARY_TAG),
      }
    },
  })

  // ── 注册 ───────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    for (const tool of tools) ctx.tools.register(tool)
  })

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: PROMPT_TEXT,
    }),
  )

  // 开机自动注入重要记忆（importance >= autoInjectMinImportance）
  async function buildAutoInject() {
    if (!config.autoInject) return ''
    const minImp = Math.max(1, Math.round(Number(config.autoInjectMinImportance) || 4))
    const items = (await store.records())
      .filter((r) => !r.deleted && r.importance >= minImp)
      .sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0))
      .slice(0, Math.max(1, Math.round(Number(config.autoInjectCount) || 8)))
    if (!items.length) return ''
    const maxChars = Math.max(60, Math.round(Number(config.autoInjectMaxChars) || 160))
    const lines = items.map((r) => {
      const text = r.text.length > maxChars ? `${r.text.slice(0, maxChars)}…` : r.text
      return `- [${r.kind}${r.tags.length ? `|${r.tags.slice(0, 3).join(',')}` : ''}] ${text}`
    })
    return `## 重要记忆自动注入（${items.length} 条 · dsh-long-memory）\n${lines.join('\n')}`
  }

  // 上下文总结注入（最新总结进上下文，供接续/翻阅）
  async function buildSummaryInject(sessionId) {
    if (!config.summaryInject) return ''
    const count = Math.max(0, Math.round(Number(config.summaryInjectCount) || 0))
    if (!count) return ''
    const all = (await store.records())
      .filter((r) => !r.deleted && (r.tags || []).includes(SUMMARY_TAG))
      .sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
    if (!all.length) return ''
    let items = all
    if (sessionId) {
      const needle = String(sessionId).toLowerCase()
      const mine = all.filter((r) => String(r.meta?.sessionId ?? '').toLowerCase().includes(needle))
      if (mine.length) items = [...mine, ...all.filter((r) => !mine.includes(r))]
    }
    items = items.slice(0, count)
    const maxChars = Math.max(200, Math.round(Number(config.summaryInjectMaxChars) || 800))
    const lines = items.map((r) => {
      const meta = r.meta && typeof r.meta === 'object' ? r.meta : {}
      const body = r.text.length > maxChars ? `${r.text.slice(0, maxChars)}…` : r.text
      const scope = meta.fromTurn != null ? ` · 第${meta.fromTurn}-${meta.toTurn ?? '?'}轮` : ''
      return `### ${meta.title ?? '(无题)'}（${meta.sessionId ?? '未知会话'}${scope} · ${String(r.created).slice(0, 10)}）\n${body}`
    })
    return `## 上下文总结（dsh-long-memory · ${items.length} 条，供接续上下文/翻阅）\n${lines.join('\n\n')}`
  }

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    const parts = []
    try {
      const block = await buildAutoInject()
      if (block) parts.push(block)
    } catch {}
    try {
      const block = await buildSummaryInject(pickSessionId(_context))
      if (block) parts.push(block)
    } catch {}
    if (!parts.length) return assembly
    const block = parts.join('\n\n')
    return {
      ...assembly,
      sections: assembly.sections.map((section) =>
        section.name === SECTION_NAME ? { ...section, text: `${section.text}\n\n${block}` } : section,
      ),
    }
  })

  // Skill 注册（工作流说明书）
  const skillFileUrl = new URL('../skills/long-memory/SKILL.md', import.meta.url)
  const skillPath = fileURLToPath(skillFileUrl)
  const candidate = {
    name: 'long-memory',
    description: '超长记忆包工作流：跨会话记忆存取与修正、长文档切块检索、聊天记录提取与精炼存档。用户说「记住/回忆上次」、要长文查找或聊天总结时使用。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'plugin',
    rank: 700,
    locator: skillFileUrl,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/long-memory/', import.meta.url)) },
  }
  try {
    ctx.skills.registerProvider(() => ({
      name,
      list: async () => [candidate],
      get: async (selected) =>
        selected?.name === candidate.name
          ? { ...candidate, content: stripFrontmatter(await readFile(skillPath, 'utf8')) }
          : undefined,
    }))
  } catch (error) {
    ctx.logger?.info?.('dsh-long-memory: skill provider registration skipped; %s', error?.message ?? error)
  }

  ctx.logger?.info?.('dsh-long-memory: ready; dataRoot=%s', root)
}
