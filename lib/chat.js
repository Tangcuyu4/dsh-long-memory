// dsh-long-memory — 聊天记录层：读取 DSH 会话投影缓存（session_projcache）
// 投影文件是「字段名 → {ver, seq, val}」的版本化状态表；解析保持容错，
// 坏文件跳过，绝不影响其它会话。

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** 投影缓存目录候选（按优先级，去重） */
export function resolveProjectionDirs(extra = []) {
  const dirs = []
  for (const d of Array.isArray(extra) ? extra : []) dirs.push(String(d))
  const dshHome = process.env.DSH_HOME
  if (dshHome) dirs.push(join(dshHome, 'storages', 'session_projcache', 'sessions'))
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'dsh-desktop', 'harness', 'storages', 'session_projcache', 'sessions'))
  }
  dirs.push(join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'))
  return [...new Set(dirs)]
}

/** 解析单个投影文件原始文本 → { turns, draft, lastPromptAt, blank, preset } */
export function parseProjection(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    // 容错：尝试按 JSONL 逐行合并（半写/分片写的情况）
    const objs = []
    for (const line of String(raw).split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        objs.push(JSON.parse(t))
      } catch {}
    }
    if (!objs.length) throw error
    data = Object.assign({}, ...objs)
  }
  // 实际落盘结构：{ version, record: { identity, rows: { <字段>: {ver, seq, val} } } }
  let map = data
  if (map && typeof map === 'object' && map.record && typeof map.record === 'object' && map.record.rows && typeof map.record.rows === 'object') {
    map = map.record.rows
  } else {
    // 兼容其它可能的包装层
    for (const key of ['state', 'projection', 'fields']) {
      if (map && typeof map === 'object' && map[key] && typeof map[key] === 'object' && (map[key].turnOutline || map[key].sessionListMetadata)) {
        map = map[key]
        break
      }
    }
  }
  const pick = (name) => {
    const entry = map ? map[name] : undefined
    if (entry && typeof entry === 'object' && 'val' in entry) return entry.val
    return entry
  }
  const outline = pick('turnOutline') || {}
  const turns = Array.isArray(outline.turns) ? outline.turns : []
  return {
    turns: turns.map((t) => ({
      turn: Number(t.turn) || 0,
      seq: t.seq,
      prompt: String(t.prompt ?? ''),
      response: String(t.response ?? ''),
    })),
    draft: String(outline.draft ?? ''),
    lastPromptAt: pick('sessionListMetadata')?.lastPromptAt ?? null,
    blank: pick('sessionListMetadata')?.blank ?? null,
    preset: pick('agentPreset') ?? null,
    model: pick('modelSelection')?.lastUsed ?? null,
    identity: data?.record?.identity ?? null,
    title: typeof pick('sessionTitle') === 'string' ? pick('sessionTitle') : pick('title') ?? null,
  }
}

export async function loadSession(file) {
  const raw = await readFile(file, 'utf8')
  return parseProjection(raw)
}

/** 列出所有可解析的会话（按 mtime 降序） */
export async function listSessions(dirs, { limit = 30 } = {}) {
  const rows = []
  for (const dir of dirs) {
    let names = []
    try {
      names = (await readdir(dir)).filter((n) => /^session-.*\.json$/i.test(n))
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(dir, name)
      try {
        const st = await stat(file)
        rows.push({ file, mtimeMs: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out = []
  for (const row of rows.slice(0, Math.max(limit * 3, limit))) {
    try {
      const parsed = await loadSession(row.file)
      const first = parsed.turns.find((t) => t.prompt.trim()) ?? parsed.turns[0]
      out.push({
        sessionId: basename(row.file, '.json'),
        file: row.file,
        mtime: new Date(row.mtimeMs).toISOString(),
        size: row.size,
        turns: parsed.turns.length,
        lastPromptAt: parsed.lastPromptAt,
        preset: parsed.preset ?? undefined,
        firstPrompt: first ? first.prompt.slice(0, 80) : '',
        lastTurn: parsed.turns.length ? parsed.turns[parsed.turns.length - 1].turn : 0,
      })
    } catch {}
    if (out.length >= limit) break
  }
  return out
}

/** 定位一个会话：'current'/留空 → 当前会话；否则按 id 包含匹配或文件路径 */
export async function resolveSession(input, { dirs, currentId } = {}) {
  const wanted = String(input ?? '').trim()
  if (!wanted || wanted === 'current') {
    if (!currentId) return null
    return findByNeedle(dirs, currentId)
  }
  if (/[/\\]/.test(wanted) && wanted.toLowerCase().endsWith('.json')) {
    try {
      const st = await stat(wanted)
      if (st.isFile()) return { sessionId: basename(wanted, '.json'), file: wanted }
    } catch {}
    return null
  }
  return findByNeedle(dirs, wanted)
}

async function findByNeedle(dirs, needle) {
  const lower = String(needle).toLowerCase()
  for (const dir of dirs) {
    let names = []
    try {
      names = (await readdir(dir)).filter((n) => /^session-.*\.json$/i.test(n))
    } catch {
      continue
    }
    const hit = names.find((n) => n.toLowerCase().includes(lower))
    if (hit) {
      const file = join(dir, hit)
      try {
        await stat(file)
        return { sessionId: basename(hit, '.json'), file }
      } catch {}
    }
  }
  return null
}

/** 截取并截断轮次 */
export function extractTurns(parsed, { from, to, maxChars = 6000 } = {}) {
  const fromN = Number.isFinite(Number(from)) && from != null ? Math.max(1, Number(from)) : 1
  const toN = Number.isFinite(Number(to)) && to != null ? Number(to) : Infinity
  const cap = Math.max(200, Number(maxChars) || 6000)
  const out = []
  for (const t of parsed.turns) {
    if (t.turn < fromN || t.turn > toN) continue
    const prompt = truncate(t.prompt, cap)
    const response = truncate(t.response, cap)
    out.push({ turn: t.turn, prompt: prompt.text, response: response.text, truncated: prompt.truncated || response.truncated })
  }
  return out
}

function truncate(text, cap) {
  const s = String(text ?? '')
  return s.length > cap ? { text: `${s.slice(0, cap)}…[已截断 ${s.length - cap} 字]`, truncated: true } : { text: s, truncated: false }
}

const COMMAND_HINT = /(git|npm|pnpm|node|npx|curl|python|pip|docker|pwsh|powershell|cargo|go |make|cmake|winget|scoop|choco|cd |mkdir|rm |cp |mv |ls |dir |install|uninstall|run|test|build|start|status|list|show|log|diff|grep|rg|find|kill|restart)/i

/** 确定性精炼骨架：逐轮主旨 + 文件/命令/URL/决定信号句 */
export function digestTurns(turns) {
  const text = turns.map((t) => `${t.prompt}\n${t.response}`).join('\n')
  const stats = { turns: turns.length, chars: text.length }
  const files = uniq(matchAll(text, /(?:[A-Za-z]:)?(?:[\w.~-]+[\\/])+[\w.~-]+\.[A-Za-z0-9]{1,6}/g)).slice(0, 40)
  const urls = uniq(matchAll(text, /https?:\/\/[^\s)"'`<>,，；;）)]+/g)).slice(0, 20)
  const commands = []
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      const t = line.trim()
      if (t && t.length <= 200 && COMMAND_HINT.test(t) && commands.length < 60) commands.push(t)
    }
  }
  const decisions = []
  for (const t of turns) {
    for (const seg of [t.response, t.prompt]) {
      for (const sentence of seg.split(/(?<=[。！？!?\n])/)) {
        const s = sentence.trim().replace(/^[-*\d.\s]+/, '')
        if (s.length > 6 && s.length <= 200 && /(决定|结论|定下来|敲定|选择|方案|约定|以后都|规则|改成|必须|不能|不要|decision|decided|conclusion)/i.test(s)) {
          if (decisions.length < 24) decisions.push(s)
        }
      }
    }
  }
  const perTurn = turns.map((t) => ({
    turn: t.turn,
    ask: oneLine(t.prompt, 90),
    got: oneLine(t.response, 90),
  }))
  return { stats, files: uniq(files), urls: uniq(urls), commands: uniq(commands).slice(0, 30), decisions: uniq(decisions), perTurn }
}

export function renderDigestText(sessionId, digest) {
  const lines = []
  lines.push(`会话 ${sessionId} 的精炼摘要（${digest.stats.turns} 轮，约 ${digest.stats.chars} 字）：`)
  for (const t of digest.perTurn) {
    lines.push(`- 第${t.turn}轮 问：${t.ask}${t.got ? ` 答：${t.got}` : ''}`)
  }
  if (digest.decisions.length) {
    lines.push('关键结论/决定：')
    for (const d of digest.decisions.slice(0, 10)) lines.push(`* ${d}`)
  }
  if (digest.files.length) lines.push(`涉及文件：${digest.files.slice(0, 12).join('、')}`)
  if (digest.commands.length) lines.push(`关键命令：${digest.commands.slice(0, 8).join(' | ')}`)
  if (digest.urls.length) lines.push(`链接：${digest.urls.slice(0, 6).join(' ')}`)
  return lines.join('\n')
}

function matchAll(text, re) {
  const out = []
  for (const m of String(text ?? '').matchAll(re)) out.push(m[0])
  return out
}

function uniq(arr) {
  return [...new Set(arr)]
}

function oneLine(text, cap) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > cap ? `${s.slice(0, cap)}…` : s
}
