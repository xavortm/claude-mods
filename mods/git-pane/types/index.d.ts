export type LinearInfo = {
  id: string
  title: string
  status: string
  statusType: string
  assignee: string
  priority: string
  url: string
} | { id: string; error: string }

export type Pr = {
  number: number
  title: string
  branch: string
  base: string
  isDraft: boolean
  review: string
  checks: 'pass' | 'fail' | 'pending' | 'none'
}

export type BranchInfo = {
  branch: string
  pr: { number: number; title: string; url: string; state: string; base: string } | null
  isInDevelop: boolean
  base: string
  authors: { name: string; count: number }[]
}

export type GitSnapshot = {
  branch: string
  ahead: number
  behind: number
  worktree: string | null
  files: { code: string; path: string }[]
  issue: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'git-pane': { snapshot: GitSnapshot | null; linear: LinearInfo | null; prs: Pr[] | null; branchInfo: BranchInfo | null }
  }
}
