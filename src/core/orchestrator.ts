import type { Message } from '../providers/types.js'
import { createSession, type Session } from './session.js'
import { PromptBuilder } from './prompt-builder.js'
import { ContextEngine } from './context-engine/index.js'
import { InferenceEngine } from '../ai/inference.js'
import type { LLMProvider } from '../providers/types.js'
import { SessionStore } from '../memory/store.js'
import { ResponseCache } from '../memory/response-cache.js'
import { getConfig } from '../runtime/state.js'
import { isFastPathCandidate, resolveFastPath } from './fast-path.js'
import pc from 'picocolors'
import { ThinkingStatus } from '../ui/thinking-status.js'
import { readFileSync, statSync } from 'fs'
import { estimateTokens } from '../ai/tokenizer.js'
import { resolve } from 'path'
import { getToolDefinitions, getTool } from '../tools/registry.js'

const MAX_AGENTIC_READS = 8
const MAX_TOOL_CALLS = 10
const MAX_READ_SIZE = 200_000
const READ_PATTERN = /@read\(([^)]+)\)/g

export class Orchestrator {
  private session: Session
  private promptBuilder: PromptBuilder
  private contextEngine: ContextEngine
  private inference: InferenceEngine
  private store: SessionStore
  private cache: ResponseCache
  private maxIterations = 25
  private lastContextTokens = 0

  constructor(provider: LLMProvider, resumeSessionId?: string) {
    this.store = new SessionStore(getConfig().storageDir)
    this.promptBuilder = new PromptBuilder()
    this.contextEngine = new ContextEngine(getConfig().nCtx ?? 8192)
    this.inference = new InferenceEngine(provider)
    this.cache = new ResponseCache()

    if (resumeSessionId) {
      const saved = this.store.load(resumeSessionId)
      if (saved) {
        this.session = saved
        process.stdout.write(pc.dim(`  Resumed session ${saved.id} (${saved.turns} turns)\n`))
      } else {
        process.stdout.write(pc.yellow(`  Session ${resumeSessionId} not found, starting new\n`))
        this.session = createSession()
      }
    } else {
      this.session = createSession()
    }

    this.initSystemMessage()
  }

  getContextUsage(): { used: number; max: number } {
    const max = getConfig().nCtx ?? 8192
    return { used: this.lastContextTokens, max }
  }

  private initSystemMessage(): void {
    if (this.session.messages[0]?.role === 'system') {
      this.contextEngine.setSystemMessage(this.session.messages[0])
      this.session.messages.shift()
    } else {
      this.contextEngine.setSystemMessage(this.promptBuilder.buildSystem())
    }
  }

  private removeContextMessages(): void {
    this.session.messages = this.session.messages.filter(
      m => m.role !== 'user' || !m.content?.startsWith('Here are the relevant project files:')
    )
  }

  private async buildContext(input: string, onStage?: (stage: import('../repo/types.js').ThinkingStage) => void): Promise<void> {
    const ctx = await this.contextEngine.selectContext(input, undefined, (evt) => onStage?.(evt.stage))
    this.promptBuilder.setFileContext(ctx)
    const systemMsg = this.promptBuilder.buildSystem()
    this.contextEngine.setSystemMessage(systemMsg)
  }

  private async suggestContext(input: string, onStage?: (stage: import('../repo/types.js').ThinkingStage) => void): Promise<void> {
    const { suggestions, tree } = await this.contextEngine.suggestContext(input, undefined, (evt) => onStage?.(evt.stage))
    this.promptBuilder.setFileContext('')
    this.promptBuilder.setFileSuggestions(suggestions, tree)
    const systemMsg = this.promptBuilder.buildSystem()
    this.contextEngine.setSystemMessage(systemMsg)
  }

  private executeRead(filePath: string): string {
    const root = process.cwd()
    const resolved = resolve(root, filePath.trim())
    if (!resolved.startsWith(root + '/') && resolved !== root) return `Error: Access denied — path outside project root`
    try {
      const stat = statSync(resolved)
      if (!stat.isFile()) return `Error: '${filePath}' is not a file`
      if (stat.size > MAX_READ_SIZE) return `Error: File too large (${(stat.size / 1024).toFixed(0)} KB)`
      if (stat.size === 0) return '(empty file)'
      const content = readFileSync(resolved, 'utf-8')
      const lines = content.split('\n')
      const limit = Math.min(lines.length, 200)
      return lines.slice(0, limit).map((l, i) => `${i + 1}: ${l}`).join('\n')
    } catch (err: any) {
      if (err.code === 'ENOENT') return `Error: File not found: '${filePath}'`
      return `Error: ${err.message}`
    }
  }

  private extractReads(text: string): string[] {
    const matches: string[] = []
    let match
    const re = new RegExp(READ_PATTERN.source, 'g')
    while ((match = re.exec(text)) !== null) {
      matches.push(match[1].trim())
    }
    return matches
  }

  private async tryCached(input: string, fingerprint: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<string | null> {
    const cached = this.cache.get(input, fingerprint)
    if (!cached) return null

    if (onToken) {
      const tokens = cached.split(/(?=\s)/)
      for (const t of tokens) {
        if (signal?.aborted) break
        onToken(t)
        await new Promise((r) => setTimeout(r, 8))
      }
    }

    return cached
  }

  async run(input: string): Promise<string> {
    if (isFastPathCandidate(input)) {
      const allFiles = this.contextEngine.getAllFiles()
      const fastResult = resolveFastPath(input, allFiles)
      if (fastResult !== null) {
        this.session.messages.push({ role: 'user', content: input })
        this.session.messages.push({ role: 'assistant', content: fastResult })
        this.session.turns++
        this.session.updatedAt = new Date().toISOString()
        this.store.save(this.session)
        return fastResult
      }
    }

    const fingerprint = this.contextEngine.getProjectFingerprint()

    const projectCached = await this.tryCached(input, fingerprint)
    if (projectCached !== null) {
      this.session.messages.push({ role: 'user', content: input })
      this.session.messages.push({ role: 'assistant', content: projectCached })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      return projectCached
    }

    const sharedCached = await this.tryCached(input, '')
    if (sharedCached !== null) {
      this.session.messages.push({ role: 'user', content: input })
      this.session.messages.push({ role: 'assistant', content: sharedCached })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      return sharedCached
    }

    const useAgentic = needsCodeContext(input)
    if (useAgentic) {
      await this.suggestContext(input)
    } else {
      this.promptBuilder.setFileContext('')
      this.promptBuilder.clearSuggestions()
      const systemMsg = this.promptBuilder.buildSystem()
      this.contextEngine.setSystemMessage(systemMsg)
    }
    this.removeContextMessages()
    if (this.promptBuilder.hasFileContext()) {
      this.session.messages.push(this.promptBuilder.buildContextMessage())
    }
    this.session.messages.push(this.promptBuilder.buildUser(input))

    let readsPerformed = 0
    let toolCallsUsed = 0
    const readFilesSet = new Set<string>()
    for (let i = 0; i < this.maxIterations; i++) {
      const pruned = this.contextEngine.prune(this.session.messages)
      this.lastContextTokens = pruned.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
      const toolDefs = useAgentic ? getToolDefinitions() : undefined
      const response = await this.inference.chat(pruned, toolDefs)

      const content = response.content ?? ''

      // Handle tool calls from function-calling protocol
      if (response.tool_calls && response.tool_calls.length > 0 && toolCallsUsed < MAX_TOOL_CALLS) {
        this.session.messages.push({ role: 'assistant', content: content || null, tool_calls: response.tool_calls })
        for (const tc of response.tool_calls) {
          const tool = getTool(tc.function.name)
          if (tool) {
            try {
              const args = JSON.parse(tc.function.arguments || '{}')
              const result = await tool.handler(args)
              const truncated = result.length > 4000 ? result.slice(0, 4000) + '\n...(truncated)' : result
              this.session.messages.push({ role: 'tool', content: truncated, tool_call_id: tc.id })
            } catch (err: any) {
              this.session.messages.push({ role: 'tool', content: `Error: ${err.message}`, tool_call_id: tc.id })
            }
            toolCallsUsed++
          }
        }
        continue
      }

      if (useAgentic && readsPerformed < MAX_AGENTIC_READS) {
        const readRequests = this.extractReads(content)
        const newReads = readRequests.filter(fp => !readFilesSet.has(fp))
        if (newReads.length > 0) {
          this.session.messages.push({ role: 'assistant', content })
          const readResults: string[] = []
          for (const fp of newReads.slice(0, MAX_AGENTIC_READS - readsPerformed)) {
            readFilesSet.add(fp)
            const fileContent = this.executeRead(fp)
            readResults.push(`Contents of \`${fp}\`:\n\`\`\`\n${fileContent}\n\`\`\``)
            readsPerformed++
          }
          this.session.messages.push({ role: 'user', content: readResults.join('\n\n') })
          continue
        } else if (readRequests.length > 0) {
          this.session.messages.push({ role: 'assistant', content })
          this.session.messages.push({ role: 'user', content: `All requested files have already been read: ${readRequests.join(', ')}. Answer using the file contents provided above.` })
          continue
        }
      }

      this.session.messages.push({ role: 'assistant', content })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      const tier = this.promptBuilder.hasFileContext() ? fingerprint : ''
      this.cache.set(input, tier, content)
      return content
    }

    this.session.updatedAt = new Date().toISOString()
    this.store.save(this.session)
    return '\nReached maximum iteration limit.'
  }

  async runStream(
    input: string,
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (isFastPathCandidate(input)) {
      const allFiles = this.contextEngine.getAllFiles()
      const fastResult = resolveFastPath(input, allFiles)
      if (fastResult !== null) {
        if (onToken) {
          const tokens = fastResult.split(/(?=\s)/)
          for (const t of tokens) {
            if (signal?.aborted) break
            onToken(t)
            await new Promise((r) => setTimeout(r, 8))
          }
        }
        this.session.messages.push({ role: 'user', content: input })
        this.session.messages.push({ role: 'assistant', content: fastResult })
        this.session.turns++
        this.session.updatedAt = new Date().toISOString()
        this.store.save(this.session)
        return fastResult
      }
    }

    const fingerprint = this.contextEngine.getProjectFingerprint()

    const projectCached = await this.tryCached(input, fingerprint, onToken, signal)
    if (projectCached !== null) {
      this.session.messages.push({ role: 'user', content: input })
      this.session.messages.push({ role: 'assistant', content: projectCached })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      return projectCached
    }

    const sharedCached = await this.tryCached(input, '', onToken, signal)
    if (sharedCached !== null) {
      this.session.messages.push({ role: 'user', content: input })
      this.session.messages.push({ role: 'assistant', content: sharedCached })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      return sharedCached
    }

    const status = new ThinkingStatus()
    const useAgenticContext = needsCodeContext(input)
    if (useAgenticContext) {
      status.start('Scanning project')
      await this.suggestContext(input, (stage) => status.update(stage))
    } else {
      this.promptBuilder.setFileContext('')
      this.promptBuilder.clearSuggestions()
      const systemMsg = this.promptBuilder.buildSystem()
      this.contextEngine.setSystemMessage(systemMsg)
      status.start('Thinking')
    }
    this.removeContextMessages()
    if (this.promptBuilder.hasFileContext()) {
      this.session.messages.push(this.promptBuilder.buildContextMessage())
    }
    this.session.messages.push(this.promptBuilder.buildUser(input))

    let readsPerformed = 0
    let toolCallsUsed = 0
    const readFilesSet = new Set<string>()

    for (let i = 0; i < this.maxIterations; i++) {
      const pruned = this.contextEngine.prune(this.session.messages)
      this.lastContextTokens = pruned.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
      status.update('Generating response')
      let firstToken = true
      let accumulated = ''
      const repAbort = new AbortController()
      const onAbort = () => repAbort.abort()
      signal?.addEventListener('abort', onAbort, { once: true })

      const wrappedOnToken = (token: string) => {
        if (firstToken) {
          firstToken = false
          status.stop()
        }
        accumulated += token
        if (detectRepetition(accumulated)) {
          repAbort.abort()
          return
        }
        onToken?.(token)
      }

      const toolDefs = useAgenticContext ? getToolDefinitions() : undefined
      let streamResult: import('../providers/types.js').LLMResponse | null = null
      try {
        streamResult = await this.inference.chatStream(pruned, toolDefs, wrappedOnToken, { signal: repAbort.signal })
      } catch (err: any) {
        if (err.name === 'AbortError' && signal?.aborted) throw err
        if (err.name === 'AbortError' && repAbort.signal.aborted && !signal?.aborted) { /* repetition abort */ }
        else throw err
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }

      if (firstToken) status.stop()

      const content = trimRepeatedTail(accumulated)

      // Handle tool calls from function-calling protocol
      if (streamResult?.tool_calls && streamResult.tool_calls.length > 0 && toolCallsUsed < MAX_TOOL_CALLS) {
        this.session.messages.push({ role: 'assistant', content: content || null, tool_calls: streamResult.tool_calls })
        for (const tc of streamResult.tool_calls) {
          const tool = getTool(tc.function.name)
          if (tool) {
            status.start('Running tool')
            try {
              const args = JSON.parse(tc.function.arguments || '{}')
              const result = await tool.handler(args)
              const truncated = result.length > 4000 ? result.slice(0, 4000) + '\n...(truncated)' : result
              this.session.messages.push({ role: 'tool', content: truncated, tool_call_id: tc.id })
              onToken?.(`\n[${tc.function.name}] ${truncated.slice(0, 100)}${truncated.length > 100 ? '...' : ''}\n`)
            } catch (err: any) {
              this.session.messages.push({ role: 'tool', content: `Error: ${err.message}`, tool_call_id: tc.id })
              onToken?.(`\n[${tc.function.name}] Error: ${err.message}\n`)
            }
            status.stop()
            toolCallsUsed++
          }
        }
        continue
      }

      // Agentic read loop: detect @read(path) patterns
      if (useAgenticContext && readsPerformed < MAX_AGENTIC_READS) {
        const readRequests = this.extractReads(content)
        const newReads = readRequests.filter(fp => !readFilesSet.has(fp))
        if (newReads.length > 0) {
          this.session.messages.push({ role: 'assistant', content })

          const readResults: string[] = []
          for (const fp of newReads.slice(0, MAX_AGENTIC_READS - readsPerformed)) {
            status.start('Reading file')
            readFilesSet.add(fp)
            const fileContent = this.executeRead(fp)
            readResults.push(`Contents of \`${fp}\`:\n\`\`\`\n${fileContent}\n\`\`\``)
            readsPerformed++
          }
          status.stop()

          const skippedDupes = readRequests.filter(fp => readFilesSet.has(fp) && !newReads.includes(fp))
          let readMsg = readResults.join('\n\n')
          if (skippedDupes.length > 0) {
            readMsg += `\n\n(Skipped already-read files: ${skippedDupes.join(', ')})`
          }
          this.session.messages.push({ role: 'user', content: readMsg })
          onToken?.('\n')
          continue
        } else if (readRequests.length > 0) {
          // All requested files were already read — tell the model
          this.session.messages.push({ role: 'assistant', content })
          this.session.messages.push({ role: 'user', content: `All requested files have already been read: ${readRequests.join(', ')}. Answer using the file contents provided above.` })
          onToken?.('\n')
          continue
        }
      }

      this.session.messages.push({ role: 'assistant', content })
      this.session.turns++
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
      const tier = this.promptBuilder.hasFileContext() ? fingerprint : ''
      this.cache.set(input, tier, content)
      return content
    }
    status.stop()

    this.session.updatedAt = new Date().toISOString()
    this.store.save(this.session)
    return '\nReached maximum iteration limit.'
  }

  getProjectTree(): string {
    return this.contextEngine.getProjectTree()
  }

  listSessions(): { id: string; createdAt: string; turns: number }[] {
    return this.store.list()
  }

  newSession(): void {
    if (this.session.turns > 0) {
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
    }
    this.session = createSession()
    this.contextEngine.setSystemMessage(this.promptBuilder.buildSystem())
    process.stdout.write(pc.green(`New session started: ${this.session.id}\n`))
  }

  switchSession(sessionId: string): boolean {
    const saved = this.store.load(sessionId)
    if (!saved) return false
    if (this.session.turns > 0) {
      this.session.updatedAt = new Date().toISOString()
      this.store.save(this.session)
    }
    this.session = saved
    this.initSystemMessage()
    process.stdout.write(pc.green(`Switched to session ${sessionId} (${saved.turns} turns)\n`))
    this.printConversation()
    return true
  }

  private printConversation(): void {
    const exchanges: { user: string; assistant: string }[] = []
    let current: { user: string; assistant: string } | null = null

    for (const m of this.session.messages) {
      if (m.role === 'user') {
        if (!current) current = { user: '', assistant: '' }
        current.user = m.content ?? ''
      } else if (m.role === 'assistant' && current) {
        current.assistant = m.content ?? ''
        exchanges.push(current)
        current = null
      }
    }

    if (exchanges.length === 0) {
      process.stdout.write(pc.dim('  (empty conversation)\n'))
      return
    }

    if (exchanges.length > 5) {
      process.stdout.write(pc.dim(`  ${exchanges.length - 5} earlier exchanges...\n`))
    }

    const slice = exchanges.length > 5 ? exchanges.slice(-5) : exchanges

    for (const e of slice) {
      const userPreview = e.user.length > 70 ? e.user.slice(0, 70) + '...' : e.user
      process.stdout.write(`  ${pc.cyan('Q:')} ${userPreview}\n`)
      if (e.assistant) {
        const asstPreview = e.assistant.length > 80 ? e.assistant.slice(0, 80) + '...' : e.assistant
        process.stdout.write(`  ${pc.green('A:')} ${asstPreview}\n`)
      }
    }
    process.stdout.write('\n')
  }
}

const CODE_SIGNALS = [
  /\b(file|function|class|module|import|export|variable|method|type|interface|error|bug|fix|refactor|test|lint|build|compile)\b/i,
  /\b(src|lib|config|package|component|endpoint|route|api|database|schema|migration)\b/i,
  /\b(where\s+is|show\s+me|find|locate|create|add|remove|update|change|rename|move|delete)\b/i,
  /\b(how\s+to|implement|write|code|debug|deploy|install|setup|configure)\b/i,
  /[./\\][\w-]+\.(ts|js|py|rs|go|java|json|yaml|md|css|html|tsx|jsx)\b/,
  /`[^`]+`/,
]

function needsCodeContext(input: string): boolean {
  return CODE_SIGNALS.some(p => p.test(input))
}

const REP_WINDOW = 60
const REP_MIN_LEN = 200

function detectRepetition(text: string): boolean {
  if (text.length < REP_MIN_LEN) return false
  const tail = text.slice(-REP_WINDOW)
  const searchIn = text.slice(0, -REP_WINDOW)
  if (searchIn.length < REP_WINDOW) return false
  let count = 0
  let pos = 0
  while ((pos = searchIn.indexOf(tail, pos)) !== -1) {
    count++
    if (count >= 2) return true
    pos++
  }
  return false
}

function trimRepeatedTail(text: string): string {
  if (text.length < REP_MIN_LEN) return text
  for (let w = 30; w <= 120; w++) {
    const tail = text.slice(-w)
    const idx = text.lastIndexOf(tail, text.length - w - 1)
    if (idx !== -1 && idx > 0) {
      return text.slice(0, idx + w).trimEnd()
    }
  }
  return text
}
