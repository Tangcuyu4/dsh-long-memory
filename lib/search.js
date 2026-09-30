// dsh-long-memory — 检索内核（纯 JS，零第三方依赖）
// 分词：ASCII 词 + CJK 滑动二元（bigram），中英混排都能查
// 打分：BM25 + 词组命中加成 + 覆盖率；记忆层额外吃 importance / recency 加成

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

/** 轻量归一（只 lowercase），索引与原文 1:1 对齐，供片段截取用 */
export function lightNorm(value) {
  return String(value ?? '').toLowerCase()
}

const TOKEN_RE = /([a-z0-9_][a-z0-9_+#./-]*)|([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/g

/** 分词并统计词频：返回 Map<term, tf>。CJK 连续串取滑动二元，单字成词 */
export function tokenize(raw) {
  const text = normalizeText(raw)
  const terms = new Map()
  const add = (term) => terms.set(term, (terms.get(term) || 0) + 1)
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(text))) {
    if (m[1]) {
      const word = m[1].replace(/[./-]+$/, '')
      if (word) add(word)
    } else {
      const run = m[2]
      if (run.length === 1) {
        add(run)
      } else {
        for (let i = 0; i < run.length - 1; i++) add(run.slice(i, i + 2))
      }
    }
  }
  return terms
}

/** 解析查询：tag:xxx kind:yyy "词组" 普通词 */
export function parseQuery(query) {
  let rest = String(query ?? '')
  const tags = []
  const kinds = []
  rest = rest.replace(/(tag|kind):([^\s"]+)/gi, (_all, key, value) => {
    ;(key.toLowerCase() === 'tag' ? tags : kinds).push(value.toLowerCase())
    return ' '
  })
  const phrases = []
  for (const m of rest.matchAll(/"([^"]{1,200})"/g)) phrases.push(m[1].trim())
  const words = rest.replace(/"[^"]*"/g, ' ').trim()
  return { tags, kinds, phrases: phrases.filter(Boolean), words }
}

/** 估算两段文本的词级重合度（对较短的一方取覆盖率），0~1 */
export function textSim(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (!ta.size || !tb.size) return 0
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  let inter = 0
  for (const t of small.keys()) if (big.has(t)) inter++
  return inter / small.size
}

const K1 = 1.4
const B = 0.75

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function applyBoosts(doc, score) {
  const meta = doc.meta || {}
  let s = score
  if (Number.isFinite(meta.importance)) {
    s *= 1 + 0.05 * clamp(Number(meta.importance) - 3, -2, 2)
  }
  const updated = Date.parse(meta.updated ?? '') || 0
  if (updated > 0) {
    const days = (Date.now() - updated) / 86_400_000
    if (days <= 3) s *= 1.15
    else if (days <= 14) s *= 1.05
    else if (days > 90) s *= 0.92
  }
  return s
}

export class SearchIndex {
  constructor() {
    this.docs = []
    this.dirty = true
    this._df = new Map()
    this._tfs = []
    this._dls = []
    this._avgdl = 0
  }

  add(doc) {
    this.docs.push(doc)
    this.dirty = true
    return doc
  }

  replaceAll(docs) {
    this.docs = docs.slice()
    this.dirty = true
  }

  get size() {
    return this.docs.length
  }

  _rebuild() {
    this._df = new Map()
    this._tfs = []
    this._dls = []
    let total = 0
    for (const doc of this.docs) {
      const tf = tokenize(doc.text)
      let dl = 0
      for (const [term, f] of tf) {
        dl += f
        this._df.set(term, (this._df.get(term) || 0) + 1)
      }
      this._tfs.push(tf)
      this._dls.push(dl)
      total += dl
    }
    this._avgdl = this.docs.length ? total / this.docs.length : 0
    this.dirty = false
  }

  /**
   * 检索。query 可以是字符串（内部 parseQuery）或 parseQuery 的返回值。
   * 返回 [{ doc, score, coverage, matchedTerms, phraseHits }]，按分降序。
   */
  search(query, { limit = 8, filter } = {}) {
    if (this.dirty) this._rebuild()
    const parsed = typeof query === 'string' ? parseQuery(query) : query
    const queryTerms = new Map()
    for (const [t, n] of tokenize(parsed.words)) {
      queryTerms.set(t, Math.max(queryTerms.get(t) || 0, n))
    }
    for (const p of parsed.phrases) {
      for (const [t] of tokenize(p)) queryTerms.set(t, Math.max(queryTerms.get(t) || 0, 2))
    }
    const n = this.docs.length
    if (!n || (!queryTerms.size && !parsed.phrases.length)) return []

    const results = []
    const normedPhrases = parsed.phrases.map((p) => lightNorm(p)).filter(Boolean)
    for (let i = 0; i < n; i++) {
      const doc = this.docs[i]
      if (filter && !filter(doc)) continue
      // 内建 tag/kind 过滤（查询里的 tag:xxx / kind:xxx）
      if (parsed.tags.length) {
        const docTags = (doc.meta && Array.isArray(doc.meta.tags) ? doc.meta.tags : []).map((t) => String(t).toLowerCase())
        if (!parsed.tags.some((t) => docTags.includes(t))) continue
      }
      if (parsed.kinds.length) {
        const docKind = doc.meta?.kind
        if (!docKind || !parsed.kinds.includes(String(docKind).toLowerCase())) continue
      }
      const tf = this._tfs[i]
      const dl = this._dls[i] || 1
      const matchedTerms = []
      let bm25 = 0
      for (const [term, weight] of queryTerms) {
        const f = tf.get(term)
        if (!f) continue
        matchedTerms.push(term)
        const df = this._df.get(term) || 1
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        bm25 += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / (this._avgdl || 1))) * weight
      }
      let phraseHits = 0
      if (normedPhrases.length) {
        const normText = doc._norm || (doc._norm = lightNorm(doc.text))
        for (const np of normedPhrases) if (normText.includes(np)) phraseHits++
      }
      if (!matchedTerms.length && !phraseHits) continue
      const coverage = queryTerms.size ? matchedTerms.length / queryTerms.size : 0
      const base = bm25 + phraseHits * 4 + coverage * 1.5
      results.push({
        doc,
        score: applyBoosts(doc, base),
        coverage,
        matchedTerms,
        phraseHits,
      })
    }
    results.sort((a, b) => b.score - a.score)
    return typeof limit === 'number' ? results.slice(0, limit) : results
  }
}

/** 截取最匹配位置附近的原文片段 */
export function makeSnippet(text, terms, width = 180) {
  const raw = String(text ?? '')
  const norm = lightNorm(raw)
  let best = -1
  let bestLen = 0
  for (const t of terms || []) {
    const term = lightNorm(t)
    if (!term) continue
    const i = norm.indexOf(term)
    if (i >= 0 && term.length > bestLen) {
      best = i
      bestLen = term.length
    }
  }
  if (best < 0) {
    return raw.length <= width * 2 ? raw : `${raw.slice(0, width * 2)}…`
  }
  const start = Math.max(0, Math.floor(best - width / 2))
  const end = Math.min(raw.length, best + Math.ceil(width / 2) + bestLen)
  const head = start > 0 ? '…' : ''
  const tail = end < raw.length ? '…' : ''
  return head + raw.slice(start, end) + tail
}
