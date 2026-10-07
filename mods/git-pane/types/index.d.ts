export type LinearInfo = {
  id: string
  title: string
  status: string
  statusType: string
  assignee: string
  priority: string
  url: string
} | { id: string; error: string }

export type TeamworkInfo = {
  id: string
  title: string
  status: string
  assignee: string
  tasklist: string
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
  files: { code: string; path: string; add: number | null; del: number | null }[]
  issue: string | null
  task: string | null
  error: string | null
}

declare module 'claude-code' {
  // Teamwork's claude.ai connector isn't always connected when the generated MCP types are written.
  interface McpToolInputs {
    'mcp__claude_ai_Teamwork__twprojects-get_task': { id: number; fields?: string[] }
    'mcp__claude_ai_Teamwork__twprojects-get_user': { id: number; fields?: string[] }
  }
  interface PluginState {
    'git-pane': { snapshot: GitSnapshot | null; linear: LinearInfo | null; teamwork: TeamworkInfo | null; prs: Pr[] | null; branchInfo: BranchInfo | null; expanded: boolean }
  }
}
