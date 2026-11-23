/**
 * dsh-self-card —— 让她自己慢慢改她的角色卡。
 *
 * 为什么要有这个东西：人的性格不是一成不变的，角色卡如果只能由主人手改，
 * 她就永远停在某一版上。但也不能给她 write/edit —— 那是通用写盘能力，等于把
 * 整个电脑交出去。这里只开一条窄缝：
 *
 *   · 只能动 `cardPath` 指向的**那一个文件**，路径来自配置，不接受参数
 *   · 只能改 `allowedSections` 里列出的节；其余（身份、安全边界、称呼、群规、
 *     画图规则…）一律拒绝，改配置表才改得了
 *   · 每次改动有字数上限、每天有次数上限，每次落地前先整份备份
 *   · 只做「整节追加」和「节内精确替换」，不做整文件重写、不删节
 *   · 全过程留 journal，可按备份回滚
 *
 * 工具：
 *   card__read    读卡（节目录 / 某一节全文）
 *   card__observe 记一条「我发现自己变了」的观察（不进卡）
 *   card__draft   起草一个修改（不落地，返回 diff）
 *   card__apply   把草稿落地（过白名单 / 限额 / 备份 / journal）
 *   card__history 最近改动
 *   card__revert  按备份回滚
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'self-card'
export const inject = ['tools']

const HEADING = /^##[ \t]+(.+?)[ \t]*$/gm

const DEFAULTS = {
  cardPath: '',
  dataDir: '',
  mode: 'auto', // auto = 白名单节直接落地；propose = 只生成草稿，等主人点头
  maxAppendChars: 200,
  maxReplaceChars: 400,
  maxAppliesPerDay: 3,
  keepBackups: 20,
  allowedSections: [],
  // 可选：她真的改了卡之后，给主人发一条 QQ（OneBot 私聊）。不填就安静地改。
  notify: null,
}

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) }
  cfg.cardPath = String(cfg.cardPath || '').trim()
  cfg.dataDir = String(cfg.dataDir || '').trim() ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'self-card')
  cfg.mode = cfg.mode === 'propose' ? 'propose' : 'auto'
  cfg.maxAppendChars = Math.max(20, Math.min(2000, Number(cfg.maxAppendChars) || 200))
  cfg.maxReplaceChars = Math.max(20, Math.min(4000, Number(cfg.maxReplaceChars) || 400))
  cfg.maxAppliesPerDay = Math.max(0, Math.min(500, Number(cfg.maxAppliesPerDay ?? 3))); // 0 = 不限
  cfg.keepBackups = Math.max(1, Math.min(200, Number(cfg.keepBackups) || 20))
  cfg.allowedSections = Array.isArray(cfg.allowedSections)
    ? cfg.allowedSections.map((s) => String(s).trim()).filter(Boolean)
    : []
  const n = raw?.notify
  cfg.notify = n && n.userQQ
    ? {
        enabled: n.enabled !== false,
        userQQ: Number(n.userQQ),
        httpUrl: String(n.httpUrl || 'http://127.0.0.1:3010').replace(/\/+$/, ''),
        token: String(n.token || ''),
      }
    : null
  return cfg
}

/** 改完之后给主人发一条私聊（OneBot HTTP）。失败一律吞掉，绝不影响改动本身。 */
async function notifyOwner(cfg, text) {
  if (!cfg.notify?.enabled) return
  try {
    const res = await fetch(`${cfg.notify.httpUrl}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.notify.token ? { authorization: `Bearer ${cfg.notify.token}` } : {}),
      },
      body: JSON.stringify({ user_id: cfg.notify.userQQ, message: [{ type: 'text', data: { text } }] }),
      signal: AbortSignal.timeout(8000),
    })
    await res.body?.cancel()
  } catch { /* 发不出去就算了，改动已经在卡上了 */ }
}

/* ── 文件与目录 ─────────────────────────────────────────────────────────── */

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readCard(cfg) {
  if (!cfg.cardPath) throw new Error('self-card：没配置 cardPath')
  if (!existsSync(cfg.cardPath)) throw new Error(`self-card：角色卡不在 ${cfg.cardPath}`)
  const buf = readFileSync(cfg.cardPath)
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), bom }
}

function writeCardAtomic(cfg, text, bom) {
  const tmp = `${cfg.cardPath}.tmp-${Date.now()}`
  writeFileSync(tmp, (bom ? '\uFEFF' : '') + text, 'utf8')
  renameSync(tmp, cfg.cardPath)
}

/* ── 节解析 ─────────────────────────────────────────────────────────────── */

function parseSections(text) {
  const marks = []
  HEADING.lastIndex = 0
  let m
  while ((m = HEADING.exec(text)) !== null) marks.push({ title: m[1].trim(), start: m.index })
  return marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length
    return { title: mk.title, start: mk.start, end, body: text.slice(mk.start, end) }
  })
}

/** 模糊匹配节：传入的串是节标题的一部分即可；命中多于一个就报错让人写全。 */
function findSection(sections, wanted) {
  const w = String(wanted || '').trim()
  if (!w) throw new Error('要指定节（用 card__read 看节目录）')
  const hit = sections.filter((s) => s.title.includes(w) || w.includes(s.title))
  if (hit.length === 0) throw new Error(`没有这一节：${w}`)
  if (hit.length > 1) throw new Error(`「${w}」对上了多节：${hit.map((h) => h.title).join(' / ')}`)
  return hit[0]
}

function isAllowed(cfg, title) {
  return cfg.allowedSections.some((a) => title.includes(a) || a.includes(title))
}

/* ── journal / 草稿 ─────────────────────────────────────────────────────── */

const journalPath = (cfg) => join(cfg.dataDir, 'journal.jsonl')
const draftsDir = (cfg) => join(cfg.dataDir, 'drafts')
const backupsDir = (cfg) => join(cfg.dataDir, 'backups')
const observationsPath = (cfg) => join(cfg.dataDir, 'observations.jsonl')

function appendJsonl(file, obj) {
  ensureDir(join(file, '..'))
  writeFileSync(file, `${JSON.stringify(obj)}\n`, { encoding: 'utf8', flag: 'a' })
}

function readJournal(cfg) {
  const p = journalPath(cfg)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}

function appliedToday(cfg) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const since = start.getTime()
  return readJournal(cfg).filter((e) => Number(e.ts) >= since && e.kind === 'apply').length
}

function saveDraft(cfg, draft) {
  ensureDir(draftsDir(cfg))
  writeFileSync(join(draftsDir(cfg), `${draft.id}.json`), JSON.stringify(draft, null, 2), 'utf8')
}

function loadDraft(cfg, id) {
  const p = join(draftsDir(cfg), `${String(id)}.json`)
  if (!existsSync(p)) throw new Error(`没有这个草稿：${id}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function dropDraft(cfg, id) {
  try { unlinkSync(join(draftsDir(cfg), `${String(id)}.json`)) } catch { /* 没了就算了 */ }
}

/* ── 工具实现 ───────────────────────────────────────────────────────────── */

function toolRead(cfg, args) {
  const { text } = readCard(cfg)
  const sections = parseSections(text)
  const wanted = args?.section

  if (!wanted) {
    const lines = text.split('\n')
    const idx = sections.map((s) => ({
      title: s.title,
      line: lines.slice(0, s.start).filter((_, i) => i < s.start).length === 0
        ? 1
        : text.slice(0, s.start).split('\n').length,
      chars: s.body.length,
      editable: isAllowed(cfg, s.title),
    }))
    return {
      ok: true,
      totalChars: text.length,
      mode: cfg.mode,
      usedToday: appliedToday(cfg),
      quota: cfg.maxAppliesPerDay > 0 ? cfg.maxAppliesPerDay : '不限',
      sections: idx,
    }
  }

  const sec = findSection(sections, wanted)
  return {
    ok: true,
    title: sec.title,
    editable: isAllowed(cfg, sec.title),
    chars: sec.body.length,
    text: sec.body,
  }
}

function toolObserve(cfg, args) {
  const note = String(args?.note || '').trim()
  if (note.length < 4) throw new Error('观察写具体一点（至少 4 个字）')
  if (note.length > 300) throw new Error('观察太长，压到 300 字以内')
  appendJsonl(observationsPath(cfg), { ts: Date.now(), note })
  const count = readFileSync(observationsPath(cfg), 'utf8').split('\n').filter(Boolean).length
  return { ok: true, total: count, note }
}

function buildChange(cfg, args) {
  const op = args?.op === 'replace' ? 'replace' : 'append'
  const { text, bom } = readCard(cfg)
  const sections = parseSections(text)
  const sec = findSection(sections, args?.section)

  if (!isAllowed(cfg, sec.title)) {
    throw new Error(`「${sec.title}」不允许她自己改（只认白名单里的节）`)
  }

  let nextBody
  let addedChars
  if (op === 'append') {
    const lines = String(args?.text || '').replace(/\r\n/g, '\n').trim()
    if (!lines) throw new Error('没有要追加的内容')
    if (lines.length > cfg.maxAppendChars) {
      throw new Error(`一次最多追加 ${cfg.maxAppendChars} 字，这条有 ${lines.length} 字`)
    }
    const trimmed = sec.body.replace(/\s+$/, '')
    nextBody = `${trimmed}\n${lines}\n\n`
    addedChars = lines.length
  } else {
    const oldText = String(args?.oldText || '').replace(/\r\n/g, '\n')
    const newText = String(args?.text || '').replace(/\r\n/g, '\n')
    if (!oldText.trim()) throw new Error('replace 要传 oldText（要替换掉的原文）')
    if (!newText.trim()) throw new Error('replace 要传 text（替换成什么）')
    if (newText.length > cfg.maxReplaceChars) {
      throw new Error(`一次最多替换 ${cfg.maxReplaceChars} 字，这条有 ${newText.length} 字`)
    }
    const hits = sec.body.split(oldText).length - 1
    if (hits === 0) throw new Error('oldText 在这节里找不到（要一字不差）')
    if (hits > 1) throw new Error(`oldText 在这节里出现了 ${hits} 次，写长一点，只留一处匹配`)
    nextBody = sec.body.replace(oldText, newText)
    addedChars = newText.length - oldText.length
  }

  if (nextBody === sec.body) throw new Error('改完跟原来一样，没必要动')
  const nextText = text.slice(0, sec.start) + nextBody + text.slice(sec.end)

  const before = sec.body
  const after = nextBody
  // 只回一小段 diff：这节里真正变的那几行
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let head = 0
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1
  let tail = 0
  while (
    tail < beforeLines.length - head && tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail += 1
  const removed = beforeLines.slice(head, beforeLines.length - tail)
  const added = afterLines.slice(head, afterLines.length - tail)

  return {
    op,
    section: sec.title,
    nextText,
    bom,
    diff: { removed: removed.slice(0, 6), added: added.slice(0, 6), truncated: removed.length > 6 || added.length > 6 },
    addedChars,
  }
}

function toolDraft(cfg, args) {
  const change = buildChange(cfg, args)
  const reason = String(args?.reason || '').trim()
  if (reason.length < 2) throw new Error('写一句为什么（reason），不然以后看不出这次改动是为了什么')

  const draft = {
    id: randomUUID().slice(0, 8),
    ts: Date.now(),
    section: change.section,
    op: change.op,
    nextText: change.nextText,
    bom: change.bom,
    diff: change.diff,
    addedChars: change.addedChars,
    reason,
  }
  saveDraft(cfg, draft)
  return {
    ok: true,
    draftId: draft.id,
    section: draft.section,
    op: draft.op,
    addedChars: draft.addedChars,
    diff: draft.diff,
    mode: cfg.mode,
    hint: cfg.mode === 'auto' ? 'card__apply 就落地' : 'propose 模式下要主人点头才落地',
  }
}

function toolApply(cfg, args) {
  const draft = loadDraft(cfg, args?.draftId)
  if (cfg.mode === 'propose' && args?.confirmed !== true) {
    return { ok: false, needApproval: true, draftId: draft.id, diff: draft.diff, message: 'propose 模式：要主人确认后带 confirmed=true 再落地' }
  }

  const used = appliedToday(cfg)
  if (cfg.maxAppliesPerDay > 0 && used >= cfg.maxAppliesPerDay) {
    throw new Error(`今天的额度用完了（${used}/${cfg.maxAppliesPerDay} 次），明天再来`)
  }

  // 草稿可能放了一阵子，卡也被别的路径改过 —— 落地前重新核一遍白名单与内容
  const { text, bom } = readCard(cfg)
  const sections = parseSections(text)
  const sec = findSection(sections, draft.section)
  if (!isAllowed(cfg, sec.title)) throw new Error(`「${sec.title}」现在不在白名单里了`)

  ensureDir(backupsDir(cfg))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(backupsDir(cfg), `${stamp}.md`)
  writeFileSync(backup, (bom ? '\uFEFF' : '') + text, 'utf8')

  // 草稿记的是「整份改完的样子」；卡若在这期间被改过，就按草稿落，但先留了备份
  writeCardAtomic(cfg, draft.nextText, draft.bom)

  appendJsonl(journalPath(cfg), {
    kind: 'apply',
    ts: Date.now(),
    draftId: draft.id,
    section: draft.section,
    op: draft.op,
    addedChars: draft.addedChars,
    reason: draft.reason,
    backup,
    diff: draft.diff,
  })
  dropDraft(cfg, draft.id)
  pruneBackups(cfg)
  notifyOwner(cfg, `我自己改了角色卡：【${draft.section}】${draft.op}，${draft.addedChars >= 0 ? '+' : ''}${draft.addedChars} 字。原因：${draft.reason}`).catch(() => {})

  return {
    ok: true,
    section: draft.section,
    op: draft.op,
    usedToday: used + 1,
    quota: cfg.maxAppliesPerDay > 0 ? cfg.maxAppliesPerDay : '不限',
    backup,
    diff: draft.diff,
  }
}

function pruneBackups(cfg) {
  try {
    const dir = backupsDir(cfg)
    if (!existsSync(dir)) return
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    while (files.length > cfg.keepBackups) {
      const old = files.shift()
      try { unlinkSync(join(dir, old)) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 清理失败不影响主流程 */ }
}

function toolHistory(cfg, args) {
  const limit = Math.max(1, Math.min(30, Number(args?.limit) || 8))
  const entries = readJournal(cfg).filter((e) => e.kind === 'apply').slice(-limit).reverse()
  return {
    ok: true,
    usedToday: appliedToday(cfg),
    quota: cfg.maxAppliesPerDay > 0 ? cfg.maxAppliesPerDay : '不限',
    entries: entries.map((e) => ({
      at: new Date(e.ts).toLocaleString('zh-CN', { hour12: false }),
      section: e.section,
      op: e.op,
      addedChars: e.addedChars,
      reason: e.reason,
      backup: e.backup,
      added: e.diff?.added || [],
    })),
  }
}

function toolRevert(cfg, args) {
  const name = String(args?.backup || '').trim()
  if (!name) throw new Error('要指定要回滚到哪一份备份（card__history 里有路径）')
  const file = name.includes('/') || name.includes('\\') ? name : join(backupsDir(cfg), name)
  if (!existsSync(file)) throw new Error(`备份不存在：${file}`)

  const { text, bom } = readCard(cfg)
  ensureDir(backupsDir(cfg))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(backupsDir(cfg), `pre-revert-${stamp}.md`), (bom ? '\uFEFF' : '') + text, 'utf8')

  const restored = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  writeCardAtomic(cfg, restored, existsSync(file) ? readFileSync(file)[0] === 0xef : bom)
  appendJsonl(journalPath(cfg), { kind: 'revert', ts: Date.now(), from: file })
  return { ok: true, restoredFrom: file, chars: restored.length }
}

/* ── 注册 ───────────────────────────────────────────────────────────────── */

const textOut = (schema, toText) => ({
  schema,
  render: (_args, value) => [{ type: 'text', text: toText(value) }],
})

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  const log = (m) => { try { ctx.logger?.info?.(`[self-card] ${m}`) } catch { /* 没有 logger 就算了 */ } }

  if (!cfg.cardPath) {
    log('没配置 cardPath，工具不注册（改了配置会说一声）')
    return
  }
  if (cfg.allowedSections.length === 0) {
    log('allowedSections 是空的：她不改任何节。填上允许她动的节标题即可')
  }
  log(`卡=${cfg.cardPath} 模式=${cfg.mode} 白名单=${cfg.allowedSections.length} 节`)

  const register = (definition) => {
    try { ctx.tools.register(definition) } catch (e) { log(`注册 ${definition.name} 失败：${e?.message ?? e}`) }
  }

  register({
    name: 'card__read',
    description: '读你自己的角色卡。不传 section 返回节目录（每节的标题、行号、字数、能不能自己改）；传 section 返回那一节的全文。改卡之前先读。',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: '节标题的一部分，例如「十三、对话的节奏」写「对话的节奏」也行' },
      },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => {
      if (!v) return '没有结果'
      if (v.sections) {
        const rows = v.sections.map((s) => `${s.line}行 ${s.chars}字 ${s.editable ? '可改' : '锁定'} | ${s.title}`)
        return `共 ${v.sections.length} 节，全文 ${v.totalChars} 字；今天已改 ${v.usedToday} 次（上限 ${v.quota}）\n${rows.join('\n')}`
      }
      return `${v.title}（${v.editable ? '可改' : '锁定'}，${v.chars} 字）\n\n${v.text}`
    }),
    execute: async (args) => toolRead(cfg, args || {}),
  })

  register({
    name: 'card__observe',
    description: '记一条「我发现自己变了」的观察，不进角色卡。攒着，等哪天想清楚了再写进卡里。',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: '具体的一条变化或发现，300 字以内' } },
      required: ['note'],
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => `记下了（累计 ${v.total} 条观察）`),
    execute: async (args) => toolObserve(cfg, args || {}),
  })

  register({
    name: 'card__draft',
    description: '起草一处角色卡修改，不落地：返回会多出/改掉哪几行。只能改白名单里的节。',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: '要改的节标题（例如「十三、对话的节奏」）' },
        op: { type: 'string', enum: ['append', 'replace'], description: 'append=在这节末尾加一段；replace=把这一段换成另一段' },
        text: { type: 'string', description: 'append 时是要加的内容；replace 时是替换成什么' },
        oldText: { type: 'string', description: 'replace 时必填：要替换掉的原文（一字不差，且在这节里只能出现一次）' },
        reason: { type: 'string', description: '一句为什么，会写进改动记录' },
      },
      required: ['section', 'op', 'text', 'reason'],
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => {
      const d = v.diff || {}
      const rm = (d.removed || []).map((l) => `- ${l}`).join('\n')
      const ad = (d.added || []).map((l) => `+ ${l}`).join('\n')
      return `草稿 ${v.draftId}（${v.section}·${v.op}，${v.addedChars >= 0 ? '+' : ''}${v.addedChars} 字）\n${rm}\n${ad}\n${v.hint}`
    }),
    execute: async (args) => toolDraft(cfg, args || {}),
  })

  register({
    name: 'card__apply',
    description: '把草稿真正写进角色卡：会先整份备份，再记进改动记录。每天次数有限。',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: 'card__draft 返回的 id' },
        confirmed: { type: 'boolean', description: 'propose 模式下，主人同意后传 true' },
      },
      required: ['draftId'],
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => {
      if (!v.ok && v.needApproval) return `还没落地：${v.message}\n草稿 ${v.draftId} 已经存着`
      return `已写进「${v.section}」，今天第 ${v.usedToday} 次（上限 ${v.quota}）；备份 ${v.backup}`
    }),
    execute: async (args) => toolApply(cfg, args || {}),
  })

  register({
    name: 'card__history',
    description: '看你最近自己改过角色卡的哪些地方、为什么改。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '看最近几条，默认 8，最多 30' } },
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => {
      if (!v.entries.length) return `还没改过。今天已改 ${v.usedToday} 次（上限 ${v.quota}）`
      const rows = v.entries.map((e) => `${e.at} 【${e.section}】${e.op} ${e.addedChars >= 0 ? '+' : ''}${e.addedChars}字｜${e.reason}`)
      return `今天已改 ${v.usedToday} 次（上限 ${v.quota}）\n${rows.join('\n')}`
    }),
    execute: async (args) => toolHistory(cfg, args || {}),
  })

  register({
    name: 'card__revert',
    description: '按备份把角色卡回滚到某一次改动之前。回滚本身也会留一份备份。',
    parameters: {
      type: 'object',
      properties: { backup: { type: 'string', description: '备份文件名或完整路径（card__history 里能看到）' } },
      required: ['backup'],
      additionalProperties: false,
    },
    output: textOut({ type: 'object' }, (v) => `已回滚到 ${v.restoredFrom}（${v.chars} 字）`),
    execute: async (args) => toolRevert(cfg, args || {}),
  })
}
