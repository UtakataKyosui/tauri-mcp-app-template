// この Mod が $.tool.register で生やすツールの入力。McpToolInputs へ宣言マージすると
// `tool.call` の matcher が名前を受け取り、`e` が引数ごと narrow される。
// 引数は `e.input` ではなく `e` 直下に来る。
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__kanban__board: {
      status?: "backlog" | "ready" | "doing" | "review" | "done" | "blocked"
    }
    mcp__kanban__card: {
      id: string
    }
    mcp__kanban__progress: {
      id: string
      note: string
      summary?: string
    }
    mcp__kanban__move: {
      id: string
      status: "backlog" | "ready" | "doing" | "review" | "done" | "blocked"
    }
    mcp__kanban__dispatch: {
      id: string
      prompt?: string
    }
  }
}
