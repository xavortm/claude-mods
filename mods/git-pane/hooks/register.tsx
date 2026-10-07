import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BranchInfo, GitSnapshot, LinearInfo, Pr, TeamworkInfo } from '../types'

const PANE = 'git-pane'
// Linear-style issue key in a branch name, like ABC-123.
const ISSUE_ID = /(?<![a-z0-9])[a-z]{2,6}-\d{1,6}(?![a-z0-9])/i
const snapshot = atom({ plugin: 'git-pane', key: 'snapshot' } as const, null)
const branchInfo = atom({ plugin: 'git-pane', key: 'branchInfo' } as const, null)
const prs = atom({ plugin: 'git-pane', key: 'prs' } as const, null)
const linear = atom({ plugin: 'git-pane', key: 'linear' } as const, null)
const expanded = atom({ plugin: 'git-pane', key: 'expanded' } as const, false)
const teamwork = atom({ plugin: 'git-pane', key: 'teamwork' } as const, null)

type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const collect = async (run: Run): Promise<GitSnapshot> => {
  const status = await run(['git', 'status', '--porcelain=v1', '-b'])
  if (status.exitCode !== 0) {
    return { branch: '', ahead: 0, behind: 0, worktree: null, files: [], issue: null, task: null, error: status.stderr.trim() || 'git failed' }
  }
  const [head = '', ...rest] = status.stdout.split('\n').filter(Boolean)
  const branch = head.replace(/^## /, '').split('...')[0] ?? ''
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0)
  const numstat = await run(['git', 'diff', 'HEAD', '--numstat', '--no-renames'])
  const counts = new Map<string, { add: number | null; del: number | null }>()
  for (const l of numstat.exitCode === 0 ? numstat.stdout.split('\n') : []) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m) counts.set(m[3]!, { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) })
  }
  const dirs = await run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  const [gitDir = '', commonDir = '', top = ''] = dirs.stdout.split('\n')
  const isWorktree = gitDir !== '' && commonDir !== '' && gitDir !== commonDir

  return {
    branch,
    ahead,
    behind,
    worktree: isWorktree ? top.split('/').pop() || 'worktree' : null,
    files: rest.map(l => {
      const path = l.slice(3)
      const c = counts.get(path.split(' -> ').pop() ?? path)

      return { code: l.slice(0, 2), path, add: c?.add ?? null, del: c?.del ?? null }
    }),
    issue: branch.match(ISSUE_ID)?.[0].toUpperCase() ?? null,
    task: branch.match(/(?<!\d)\d{7,9}(?!\d)/)?.[0] ?? null,
    error: null,
  }
}

const fileLook = (code: string): { icon: string; color: string } => {
  if (code.includes('?')) return { icon: '?', color: 'gray' }
  if (code.includes('D')) return { icon: '✖', color: 'red' }
  if (code.includes('A')) return { icon: '＋', color: 'green' }
  if (code.includes('R')) return { icon: '➜', color: 'magenta' }
  if (code.includes('U')) return { icon: '⚠', color: 'red' }
  return { icon: code[0] !== ' ' ? '●' : '✎', color: code[0] !== ' ' ? 'green' : 'yellow' }
}

const MAX_DIRS = 3
const MAX_FILES = 15

// Keeps the last MAX_DIRS directories and marks anything cut with a leading "…/".
const splitPath = (raw: string): { dir: string; name: string } => {
  const parts = (raw.split(' -> ').pop() ?? raw).split('/')
  const name = parts.pop() ?? ''
  const dirs = parts.slice(-MAX_DIRS)

  return { dir: dirs.length ? `${parts.length > MAX_DIRS ? '…/' : ''}${dirs.join('/')}/` : '', name }
}

const statusColor =(type: string): string =>
  type === 'completed' ? 'green' : type === 'started' ? 'yellow' : type === 'canceled' ? 'red' : 'blue'

async function refresh($: EngineInterface) {
  const next = await collect(argv => $.process.run(argv, { timeoutMs: 5000 }))
  await update($, snapshot, () => next)
  $.ui.status(next.error ? undefined : `⎇ ${next.branch}${next.worktree ? ' 🌳 WORKTREE' : ''}`)
}

let hostKind: Promise<'gitlab' | 'github'> | null = null

// GitLab remotes use glab, everything else uses gh. Detected once from the origin URL.
const detectHost = ($: EngineInterface) =>
  (hostKind ??= $.process
    .run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
    .then(r => (/gitlab/i.test(r.stdout) ? 'gitlab' : 'github')))

const glMrState = (s: string): string => (s === 'merged' ? 'MERGED' : s === 'opened' ? 'OPEN' : 'CLOSED')

const glChecks = (status: string): Pr['checks'] =>
  status === 'mergeable' ? 'pass' : status === 'ci_still_running' ? 'pending' : status === 'ci_must_pass' ? 'fail' : 'none'

async function refreshPrs($: EngineInterface) {
  try {
    if ((await detectHost($)) === 'gitlab') {
      const r = await $.process.run(['glab', 'mr', 'list', '--per-page', '10', '-F', 'json'], { timeoutMs: 15000 })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'glab failed')
      const list: Pr[] = JSON.parse(r.stdout || '[]').map((m: any): Pr => ({
        number: m.iid,
        title: m.title,
        branch: m.source_branch,
        base: m.target_branch,
        isDraft: !!m.draft,
        review: '',
        checks: glChecks(m.detailed_merge_status ?? ''),
      }))
      await update($, prs, () => list)
      return
    }
    const r = await $.process.run(
      ['gh', 'pr', 'list', '--state', 'open', '--limit', '10', '--json', 'number,title,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup'],
      { timeoutMs: 15000 },
    )
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'gh failed')
    const list: Pr[] = JSON.parse(r.stdout).map((p: any): Pr => {
      const cs: any[] = p.statusCheckRollup ?? []
      const bad = cs.some(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state))
      const wait = cs.some(c => !(c.conclusion ?? c.state) || ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(c.status ?? c.state))
      return {
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        base: p.baseRefName,
        isDraft: p.isDraft,
        review: p.reviewDecision ?? '',
        checks: cs.length === 0 ? 'none' : bad ? 'fail' : wait ? 'pending' : 'pass',
      }
    })
    await update($, prs, () => list)
  } catch (err) {
    $.ui.toast(`PR list failed: ${String(err).slice(0, 80)}`)
    await update($, prs, () => [])
  }
}

async function refreshBranch($: EngineInterface, branch: string) {
  const run: Run = argv => $.process.run(argv, { timeoutMs: 15000 })
  let pr: BranchInfo['pr'] = null
  if ((await detectHost($)) === 'gitlab') {
    const r = await run(['glab', 'mr', 'list', '--source-branch', branch, '--all', '--per-page', '1', '-F', 'json'])
    if (r.exitCode === 0) {
      const m = JSON.parse(r.stdout || '[]')[0]
      if (m) pr = { number: m.iid, title: m.title, url: m.web_url, state: glMrState(m.state), base: m.target_branch }
    }
  } else {
    const r = await run(['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,title,url,state,baseRefName'])
    if (r.exitCode === 0) {
      const p = JSON.parse(r.stdout || '[]')[0]
      if (p) pr = { number: p.number, title: p.title, url: p.url, state: p.state, base: p.baseRefName }
    }
  }
  const anc = await run(['git', 'merge-base', '--is-ancestor', 'HEAD', 'origin/develop'])
  const base = pr?.base ?? 'develop'
  const sl = branch === base ? null : await run(['git', 'shortlog', '-sn', '--no-merges', `origin/${base}..HEAD`])
  const authors = (sl?.exitCode === 0 ? sl.stdout : '')
    .split('\n')
    .map(l => l.match(/^\s*(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => ({ count: Number(m[1]), name: m[2]! }))
  await update($, branchInfo, () => ({ branch, pr, isInDevelop: anc.exitCode === 0, base, authors }))
}

const humanize = (branch: string): string => {
  const words = branch.replace(/^[a-z]+\//, '').replace(/^[a-z]{2,6}-\d+-?/i, '').replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : branch
}

async function copy($: EngineInterface, text: string) {
  const r = await $.process.run(['sh', '-c', 'printf %s "$1" | pbcopy', '_', text], { timeoutMs: 5000 })
  $.ui.toast(r.exitCode === 0 ? `✔ Copied ${text.length > 60 ? text.slice(0, 57) + '…' : text}` : '✖ Copy failed', { timeoutMs: 3000 })
}

async function checkout($: EngineInterface, n: number) {
  const gitlab = (await detectHost($)) === 'gitlab'
  const r = await $.process.run(gitlab ? ['glab', 'mr', 'checkout', String(n)] : ['gh', 'pr', 'checkout', String(n)], { timeoutMs: 30000 })
  $.ui.toast(r.exitCode === 0 ? `✔ Checked out ${gitlab ? 'MR !' : 'PR #'}${n}` : `✖ ${r.stderr.trim().split('\n').pop()}`, { timeoutMs: 7000 })
  await refresh($)
  const snap = await read($, snapshot)
  if (snap) await refreshBranch($, snap.branch)
}

async function refreshLinear($: EngineInterface, id: string) {
  try {
    const r = await $.tool.call({
      tool: 'mcp__linear__get_issue',
      id,
      fields: ['id', 'title', 'status', 'statusType', 'assignee', 'priority', 'url'],
    })
    const text = typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? '')
    const j = JSON.parse(text.slice(text.indexOf('{')))
    const pick = (v: unknown): string =>
      typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as { name?: string }).name ?? '') : ''
    const info: LinearInfo = {
      id,
      title: pick(j.title),
      status: pick(j.status),
      statusType: pick(j.statusType),
      assignee: pick(j.assignee),
      priority: pick(j.priority),
      url: pick(j.url),
    }
    await update($, linear, () => info)
  } catch (err) {
    await update($, linear, () => ({ id, error: String(err).slice(0, 80) }))
  }
}

const TW = 'mcp__claude_ai_Teamwork__'
const twUsers = new Map<number, string>()

const twJson = (r: { text?: unknown; result?: unknown }): any => {
  const res: any = r.result
  const blocks = Array.isArray(res) ? res : Array.isArray(res?.content) ? res.content : null
  const text =
    typeof r.text === 'string'
      ? r.text
      : blocks
        ? blocks.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
        : typeof res === 'string'
          ? res
          : JSON.stringify(res ?? '')
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(body)
  } catch (err) {
    throw new Error(`${String(err).slice(0, 30)} len=${text.length} head=${text.slice(0, 25)} tail=${text.slice(-25)}`)
  }
}

async function twAssignee($: EngineInterface, userId: number | undefined): Promise<string> {
  if (!userId) return ''
  const hit = twUsers.get(userId)
  if (hit !== undefined) return hit
  try {
    const u = twJson(await $.tool.call({ tool: `${TW}twprojects-get_user`, id: userId, fields: ['id', 'firstName', 'lastName'] })).user ?? {}
    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
    twUsers.set(userId, name)

    return name
  } catch {
    return ''
  }
}

async function refreshTeamwork($: EngineInterface, id: string) {
  try {
    const t = twJson(
      await $.tool.call({
        tool: `${TW}twprojects-get_task`,
        id: Number(id),
        fields: ['id', 'name', 'status', 'priority', 'assignees', 'tasklist'],
      }),
    ).task
    if (!t) throw new Error('task not found')
    const info: TeamworkInfo = {
      id,
      title: String(t.name ?? ''),
      status: String(t.status ?? ''),
      assignee: await twAssignee($, t.assignees?.[0]?.id),
      tasklist: String(t.tasklist?.meta?.name ?? ''),
      priority: String(t.priority ?? ''),
      url: String(t.meta?.webLink ?? ''),
    }
    await update($, teamwork, () => info)
  } catch (err) {
    await update($, teamwork, () => ({ id, error: String(err).slice(0, 200) }))
  }
}

export const register: Register = (on, options) => {
  let lastIssue: string | null = null
  let lastTask: string | null = null
  let lastTaskAt = 0
  let lastBranch = ''
  let lastAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'git-pane', description: 'Show live git status + Linear/Teamwork task in a pane' })
    $.clock.every(3000, () => void refresh($))
    void refreshPrs($)
    $.clock.every(60000, async () => {
      void refreshPrs($)
      const snap = await read($, snapshot)
      if (snap && !snap.error) void refreshBranch($, snap.branch)
    })

    return next(e)
  })

  on('command.run', { command: 'git-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: ' Git' })
    await refresh($)
    void refreshPrs($)
    const snap = await read($, snapshot)
    if (snap && !snap.error) void refreshBranch($, snap.branch)

    return { text: 'Git pane opened.' }
  })

  // Re-fetch Linear when the branch's issue changes, else at most every 2 minutes.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    const s = await read($, snapshot)
    const now = await $.clock.now()
    if (s && !s.error && s.branch !== lastBranch) {
      lastBranch = s.branch
      void refreshBranch($, s.branch)
    }
    if (s?.issue && (s.issue !== lastIssue || now - lastAt > 120000)) {
      lastIssue = s.issue
      lastAt = now
      void refreshLinear($, s.issue)
    }
    if (s?.task && (s.task !== lastTask || now - lastTaskAt > 120000)) {
      lastTask = s.task
      lastTaskAt = now
      void refreshTeamwork($, s.task)
    }

    return ran
  })

  // Opt-in via the blockWorktrees setting: keep work in the main checkout.
  if (options.blockWorktrees === true) {
    const NO_WORKTREE = 'Worktrees are blocked by the git-pane blockWorktrees setting. Use a normal branch in the main checkout instead.'
    on('tool.call', { tool: 'EnterWorktree' }, () => ({ deny: NO_WORKTREE }))
    on('tool.call', { tool: 'Bash' }, async (_$, e, next) => {
      if (/\bgit\s+worktree\s+add\b/.test(e.command)) return { deny: NO_WORKTREE }

      return next(e)
    })
  }

  // Always-on branch line right above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (!s || s.error) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const isProtected = s.branch === 'develop' || s.branch === 'master'
    const dirty = s.files.length

    return (
      <Box>
        <Text color="magenta">⎇ </Text>
        <Text bold color={isProtected ? 'red' : 'cyan'}>{s.branch}</Text>
        {s.ahead > 0 && <Text color="green"> ↑{s.ahead}</Text>}
        {s.behind > 0 && <Text color="yellow"> ↓{s.behind}</Text>}
        {s.issue && <Text color="blue"> ◆ {s.issue}</Text>}
        {s.task && <Text color="blue"> ◆ #{s.task}</Text>}
        <Text color={dirty ? 'yellow' : 'green'}> {dirty ? `✎ ${dirty}` : '✔'}</Text>
        {s.worktree && <Text bold color="black" backgroundColor="yellow"> 🌳 WORKTREE {s.worktree} </Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const l = await read($, linear)
    const tw = await read($, teamwork)
    const open = (await read($, expanded)) === true
    const pl = await read($, prs)
    const bi = await read($, branchInfo)
    if (!s) return <Text dimColor>⏳ Loading…</Text>
    if (s.error) return <Text color="red">✖ {s.error}</Text>

    const protectedBranch = s.branch === 'develop' || s.branch === 'master'
    const totalAdd = s.files.reduce((n, f) => n + (f.add ?? 0), 0)
    const totalDel = s.files.reduce((n, f) => n + (f.del ?? 0), 0)

    const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, '')
    const hasLinear = !!l && l.id === s.issue && 'title' in l
    const linearTitle = hasLinear && 'title' in l ? l.title : ''
    const ownPr = bi && bi.branch === s.branch ? bi : null
    const authors = ownPr?.authors ?? []
    const desc = ownPr?.pr?.title || (hasLinear ? '' : humanize(s.branch))
    const showDesc = desc !== '' && norm(desc) !== norm(linearTitle)

    return (
      <Box flexDirection="column">
        <Text bold color="magenta">━━ GIT ━━━━━━━━━━━━━━</Text>
        <Box>
          <Text>
            <Text color="magenta">⎇ </Text>
            <Text bold color={protectedBranch ? 'red' : 'cyan'}>{s.branch}</Text>
            {s.ahead > 0 && <Text color="green"> ↑{s.ahead}</Text>}
            {s.behind > 0 && <Text color="yellow"> ↓{s.behind}</Text>}
            {protectedBranch && <Text color="red"> ⚠ protected</Text>}
          </Text>
          <Box marginLeft={1}>
            <Button key="copy-branch" label="copy" onPress={() => copy($, s.branch)} />
          </Box>
        </Box>
        {showDesc && <Text wrap="truncate-end" dimColor>  {desc}</Text>}
        {s.worktree && (
          <Text bold color="black" backgroundColor="yellow"> 🌳 WORKTREE: {s.worktree} </Text>
        )}
        {ownPr !== null && (
          <Box flexDirection="column">
            {ownPr.pr === null && <Text color="gray">  ○ no PR yet</Text>}
            {ownPr.pr !== null && (
              <Text wrap="truncate-end">
                <Text color={ownPr.pr.state === 'MERGED' ? 'magenta' : ownPr.pr.state === 'OPEN' ? 'green' : 'red'}>
                  {'  '}{ownPr.pr.state === 'MERGED' ? '✔ merged' : ownPr.pr.state === 'OPEN' ? '◌ open' : '✖ closed'} PR #{ownPr.pr.number}
                </Text>
                <Text color={ownPr.pr.base === 'master' && !s.branch.startsWith('hotfix/') ? 'red' : 'cyan'} bold> → {ownPr.pr.base}</Text>
                {ownPr.pr.base === 'master' && !s.branch.startsWith('hotfix/') && <Text color="red"> ⚠ targets master</Text>}
              </Text>
            )}
            {ownPr.pr !== null && (
              <Box>
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate-end">  {ownPr.pr.url}</Text>
                </Box>
                <Box marginLeft={1}>
                  <Button key="copy-pr-url" label="copy" onPress={() => copy($, ownPr.pr!.url)} />
                </Box>
              </Box>
            )}
            {ownPr.pr === null && ownPr.isInDevelop && <Text color="yellow">  ≡ no commits beyond develop</Text>}
            {ownPr.pr !== null && ownPr.pr.state !== 'MERGED' && ownPr.isInDevelop && <Text color="magenta">  ✔ already contained in develop</Text>}
            {authors.length > 0 && (
              <Text wrap="truncate-end">
                <Text color="green">  👥 </Text>
                {authors.map(a => `${a.name} (${a.count})`).join(', ')}
                <Text dimColor> since {ownPr.base ?? 'develop'}</Text>
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">
            Changes <Text dimColor>({s.files.length})</Text>
            {totalAdd > 0 && <Text color="green"> +{totalAdd}</Text>}
            {totalDel > 0 && <Text color="red"> -{totalDel}</Text>}
          </Text>
          {s.files.length === 0 && <Text color="green">✔ Working tree clean</Text>}
          {(open ? s.files : s.files.slice(0, MAX_FILES)).map(f => {
            const { icon, color } = fileLook(f.code)
            const { dir, name } = splitPath(f.path)
            return (
              <Text wrap="truncate-start">
                <Text color={color}>{icon} </Text>
                <Text color="gray">{dir}</Text>
                <Text bold color={color}>{name}</Text>
                {f.add !== null && f.add > 0 && <Text color="green"> +{f.add}</Text>}
                {f.del !== null && f.del > 0 && <Text color="red"> -{f.del}</Text>}
              </Text>
            )
          })}
          {s.files.length > MAX_FILES && (
            <Button
              key="files-toggle"
              label={open ? '− show less' : `+ ${s.files.length - MAX_FILES} more`}
              onPress={() => update($, expanded, v => !v)}
            />
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold color="magenta">Open PRs <Text dimColor>({pl?.length ?? '…'})</Text></Text>
          {pl && pl.length === 0 && <Text dimColor>No open PRs</Text>}
          {(pl ?? []).map(p => {
            const ck = p.checks === 'pass' ? ['✔', 'green'] : p.checks === 'fail' ? ['✖', 'red'] : p.checks === 'pending' ? ['◔', 'yellow'] : ['·', 'gray']
            const rv = p.review === 'APPROVED' ? ['👍', 'green'] : p.review === 'CHANGES_REQUESTED' ? ['✎', 'red'] : ['○', 'gray']
            return (
              <Box flexWrap="wrap">
                <Box flexShrink={1}>
                  <Text color={ck[1]}>{ck[0]} </Text>
                  <Text color={rv[1]}>{rv[0]} </Text>
                  <Text color={p.branch === s.branch ? 'cyan' : 'white'} bold={p.branch === s.branch}>#{p.number} </Text>
                  <Text wrap="truncate-end" dimColor={p.isDraft}>{p.isDraft ? '[draft] ' : ''}{p.title} </Text>
                </Box>
                <Box marginLeft={2}>
                  <Text color={p.base === 'master' ? 'red' : 'cyan'}>→{p.base} </Text>
                  {p.branch !== s.branch && (
                    <Button key={`pr-${p.number}`} label="checkout" onPress={() => checkout($, p.number)} />
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>

        {s.issue && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="blue">━━ LINEAR ━━━━━━━━━━━━</Text>
          {s.issue && (
            <Text>
              <Text color="blue">◆ </Text>
              <Text bold color="blue">{s.issue}</Text>
              {l && 'status' in l && l.id === s.issue && (
                <Text color={statusColor(l.statusType)}> ● {l.status}</Text>
              )}
            </Text>
          )}
          {s.issue && hasLinear && 'title' in l && (
            <Box flexDirection="column">
              <Text wrap="truncate-end">  {l.title}</Text>
              <Text dimColor>  👤 {l.assignee || 'unassigned'}  ⚑ {l.priority || 'no priority'}</Text>
            </Box>
          )}
          {s.issue && l && l.id === s.issue && 'error' in l && <Text color="red">  ✖ Linear: {l.error}</Text>}
          {s.issue && (!l || l.id !== s.issue) && <Text dimColor>  ⏳ fetching from Linear…</Text>}
        </Box>
        )}

        {(s.task || !s.issue) && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="blue">━━ TEAMWORK ━━━━━━━━━━</Text>
          {!s.task && <Text dimColor>  no task id in the branch name</Text>}
          {s.task && (
            <Text>
              <Text color="blue">◆ </Text>
              <Text bold color="blue">#{s.task}</Text>
              {tw && tw.id === s.task && 'status' in tw && (
                <Text color={tw.status === 'completed' ? 'green' : tw.status === 'new' ? 'blue' : 'yellow'}> ● {tw.status}</Text>
              )}
            </Text>
          )}
          {s.task && tw && tw.id === s.task && 'title' in tw && (
            <Box flexDirection="column">
              <Text wrap="truncate-end">  {tw.title}</Text>
              <Text dimColor wrap="truncate-end">  👤 {tw.assignee || 'unassigned'}  ☰ {tw.tasklist || 'no list'}</Text>
            </Box>
          )}
          {s.task && tw && tw.id === s.task && 'error' in tw && <Text color="red">  ✖ Teamwork: {tw.error}</Text>}
          {s.task && (!tw || tw.id !== s.task) && <Text dimColor>  ⏳ fetching from Teamwork…</Text>}
        </Box>
        )}
      </Box>
    )
  })
}
