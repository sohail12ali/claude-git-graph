export type GraphCommit = {
  hash: string
  graph: string
  subject: string
  author: string
  when: string
  date: string
  refs: string[]
  parents: string[]
}
export type FileChange = { status: string; path: string; add: number; del: number }
export type Detail = {
  hash: string
  base: string
  title: string
  meta: string[]
  message: string
  files: FileChange[]
}
export type View = { branch: string; query: string; showRemotes: boolean }
export type Branches = { local: string[]; remote: string[]; current: string }
export type Patch = { path: string; diff: string }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': {
      commits: Shaped<GraphCommit[]>
      branches: Shaped<Branches>
      view: Shaped<View>
      selected: Shaped<string>
      detail: Shaped<Detail>
      patch: Shaped<Patch>
      mark: Shaped<string>
      pending: Shaped<string>
      note: Shaped<string>
      dirty: Shaped<number>
      error: Shaped<string>
      folder: Shaped<string>
    }
  }
}
