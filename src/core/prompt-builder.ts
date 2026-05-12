import type { Message } from '../providers/types.js'
import { buildSystemPrompt, AGENTIC_CONTEXT_PROMPT } from '../ai/templates.js'

export class PromptBuilder {
  private systemExtra: string | null = null
  private fileContext: string | null = null
  private fileSuggestions: string | null = null
  private projectTree: string | null = null

  setExtraContext(ctx: string): void {
    this.systemExtra = ctx
  }

  setFileContext(ctx: string): void {
    this.fileContext = ctx || null
  }

  setFileSuggestions(suggestions: string, tree: string): void {
    this.fileSuggestions = suggestions || null
    this.projectTree = tree || null
  }

  clearSuggestions(): void {
    this.fileSuggestions = null
    this.projectTree = null
  }

  hasFileContext(): boolean {
    return (this.fileContext !== null && this.fileContext.length > 0) ||
           (this.fileSuggestions !== null && this.fileSuggestions.length > 0)
  }

  buildSystem(): Message {
    let content = buildSystemPrompt(this.systemExtra ?? undefined)
    if (this.fileContext) {
      content += `\n\nRelevant project files:\n${this.fileContext}`
    }
    if (this.fileSuggestions) {
      content += `\n\n${AGENTIC_CONTEXT_PROMPT}`
      if (this.projectTree) {
        content += `\n\nProject structure:\n${this.projectTree}`
      }
      content += `\n\nLikely relevant files:\n${this.fileSuggestions}`
    }
    return { role: 'system', content }
  }

  buildUser(input: string): Message {
    return { role: 'user', content: input }
  }
}
