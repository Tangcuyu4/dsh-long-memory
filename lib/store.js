// dsh-long-memory — 记忆存储层（JSON 原子写，多进程安全靠 mtime 戳检测）
// 记录结构：{ id, kind, text, tags, importance, source, created, updated, deleted, deletedAt, history, meta }

import { mkdir, readFile, rename, stat, appendFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export function nowIso() {
  return new Date().toISOString()
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function normTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean))]
}

export class MemoryStore {
  constructor(root) {
    this.root = root
    this.file = join(root, 'memories.json')
    this.trashFile = join(root, 'trash.jsonl')
    this._cache = null
    this._stamp = null
  }

  /** 读取整个库（带 mtime 戳缓存：外部改过会自动重载） */
  async db() {
    await mkdir(this.root, { recursive: true })
    let st = null
    try {
      st = await stat(this.file)
    } catch {}
    if (!st) {
      this._cache = { version: 1, seq: 0, records: [] }
      return this._cache
    }
    if (this._cache && this._stamp && this._stamp.mtimeMs === st.mtimeMs && this._stamp.size === st.size) {
      return this._cache
    }
    const raw = JSON.parse(await readFile(this.file, 'utf8'))
    this._cache = {
      version: 1,
      seq: Number(raw.seq) || 0,
      records: Array.isArray(raw.records) ? raw.records : [],
    }
    this._stamp = { mtimeMs: st.mtimeMs, size: st.size }
    return this._cache
  }

  async records() {
    return (await this.db()).records
  }

  async _save() {
    await mkdir(this.root, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(this._cache, null, 1)}\n`, 'utf8')
    await rename(tmp, this.file)
    const st = await stat(this.file)
    this._stamp = { mtimeMs: st.mtimeMs, size: st.size }
  }

  async add({ text, kind = 'note', tags = [], importance = 3, source = 'agent', meta = {} } = {}) {
    const db = await this.db()
    const record = {
      id: newId('m'),
      kind: String(kind) || 'note',
      text: String(text ?? '').trim(),
      tags: normTags(tags),
      importance: clampInt(importance, 1, 5, 3),
      source: String(source ?? 'agent'),
      created: nowIso(),
      updated: nowIso(),
      deleted: false,
      deletedAt: null,
      history: [],
      meta: meta && typeof meta === 'object' ? meta : {},
    }
    db.records.push(record)
    db.seq++
    await this._save()
    return record
  }

  async update(id, patch = {}) {
    const db = await this.db()
    const record = db.records.find((r) => r.id === id && !r.deleted)
    if (!record) return null
    if (typeof patch.text === 'string' && patch.text.trim() && patch.text.trim() !== record.text) {
      record.history.push({ text: record.text, at: record.updated })
      if (record.history.length > 5) record.history = record.history.slice(-5)
      record.text = patch.text.trim()
    }
    if (patch.tags !== undefined) record.tags = [...new Set([...record.tags, ...normTags(patch.tags)])]
    if (patch.importance !== undefined) record.importance = clampInt(patch.importance, 1, 5, record.importance)
    if (typeof patch.kind === 'string' && patch.kind) record.kind = patch.kind
    if (patch.meta && typeof patch.meta === 'object') record.meta = { ...record.meta, ...patch.meta }
    record.updated = nowIso()
    await this._save()
    return record
  }

  async get(id) {
    const db = await this.db()
    return db.records.find((r) => r.id === id) ?? null
  }

  async list({ tag, kind, includeDeleted = false, limit = 50, order = 'updated' } = {}) {
    const db = await this.db()
    let rows = db.records.filter((r) => includeDeleted || !r.deleted)
    if (tag) rows = rows.filter((r) => r.tags.includes(String(tag).toLowerCase()))
    if (kind) rows = rows.filter((r) => r.kind === kind)
    const key = ['created', 'updated', 'importance'].includes(order) ? order : 'updated'
    rows = rows.slice().sort((a, b) => {
      if (key === 'importance') return b.importance - a.importance || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0)
      return (Date.parse(b[key]) || 0) - (Date.parse(a[key]) || 0)
    })
    return rows.slice(0, clampInt(limit, 1, 500, 50))
  }

  async forget({ id, tag } = {}) {
    const db = await this.db()
    const removed = []
    for (const r of db.records) {
      if (r.deleted) continue
      if (id ? r.id === id : tag ? r.tags.includes(String(tag).toLowerCase()) : false) {
        r.deleted = true
        r.deletedAt = nowIso()
        removed.push(r)
      }
    }
    if (removed.length) await this._save()
    return removed
  }

  async purge({ id, tag, all = false } = {}) {
    const db = await this.db()
    const match = (r) =>
      all || (id ? r.id === id : tag ? r.tags.includes(String(tag).toLowerCase()) : false)
    const removed = db.records.filter(match)
    if (!removed.length) return []
    db.records = db.records.filter((r) => !match(r))
    db.seq++
    try {
      const lines = removed.map((r) => JSON.stringify({ purgedAt: nowIso(), record: r })).join('\n')
      await mkdir(this.root, { recursive: true })
      await appendFile(this.trashFile, `${lines}\n`, 'utf8')
    } catch {}
    await this._save()
    return removed
  }

  async stats() {
    const db = await this.db()
    const active = db.records.filter((r) => !r.deleted)
    const byKind = {}
    const tagCounts = new Map()
    let newest = 0
    let oldest = Infinity
    for (const r of active) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1
      for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
      const ts = Date.parse(r.updated) || 0
      if (ts > newest) newest = ts
      if (ts && ts < oldest) oldest = ts
    }
    let bytes = 0
    try {
      bytes = (await stat(this.file)).size
    } catch {}
    return {
      total: db.records.length,
      active: active.length,
      deleted: db.records.length - active.length,
      byKind,
      topTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count })),
      newestUpdated: newest ? new Date(newest).toISOString() : null,
      oldestUpdated: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      bytes,
      file: this.file,
    }
  }
}

function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}
