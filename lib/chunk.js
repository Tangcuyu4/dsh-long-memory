// dsh-long-memory — 长文切块：按行累积，块间带行对齐的 overlap，行号 1 起含端点

import { createHash } from 'node:crypto'

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 把长文本切块。返回 [{ index, startLine, endLine, text }]。
 * - 优先按行边界断开；单行超长时硬切（行号不变）
 * - 下一块开头携带上一块尾部若干行作为 overlap（行号重复，读取端按行号去重）
 */
export function chunkText(text, { chunkSize = 1200, overlap = 150 } = {}) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return []
  const size = Math.max(200, Number(chunkSize) || 1200)
  const ov = Math.max(0, Math.min(Number(overlap) || 0, Math.floor(size / 3)))
  const lines = raw.split('\n')
  const chunks = []
  let buf = [] // { line, no }
  let bufLen = 0

  const flush = () => {
    if (!buf.length) return
    chunks.push({
      index: chunks.length,
      startLine: buf[0].no,
      endLine: buf[buf.length - 1].no,
      text: buf.map((b) => b.line).join('\n'),
    })
    const tail = []
    let tailLen = 0
    for (let i = buf.length - 1; i >= 0; i--) {
      const l = buf[i].line
      if (tailLen + l.length + 1 > ov && tail.length) break
      tail.unshift(buf[i])
      tailLen += l.length + 1
      if (tailLen >= ov) break
    }
    buf = tail
    bufLen = tailLen
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const no = i + 1
    if (line.length > size) {
      flush()
      const pieces = Math.ceil(line.length / size)
      for (let p = 0; p < pieces; p++) {
        chunks.push({
          index: chunks.length,
          startLine: no,
          endLine: no,
          text: line.slice(p * size, (p + 1) * size),
        })
      }
      buf = []
      bufLen = 0
      continue
    }
    if (bufLen && bufLen + line.length + 1 > size) flush()
    if (bufLen && bufLen + line.length + 1 > size) {
      // overlap 尾部 + 当前行仍然超块（罕见）：丢弃尾部硬开新块
      buf = []
      bufLen = 0
    }
    buf.push({ line, no })
    bufLen += line.length + 1
  }
  flush()
  return chunks
}
