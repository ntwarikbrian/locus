import { createHash } from 'crypto'
import { join } from 'path'
import type { Message } from '../../providers/types.js'
import { estimateTokens, truncateToTokens } from '../../ai/tokenizer.js'
import { RepoScanner, buildFlatList, type ScanResult, type FileNode } from '../../repo/scanner.js'
import { RepoIndexer } from '../../repo/indexer.js'
import { FileSelector } from './selector.js'
import { truncateSmart } from './truncator.js'
import { getBudget, trimHistoryToBudget } from './budget.js'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import type { ThinkingProgressEvent, ThinkingStage } from '../../repo/types.js'

export type { TokenBudget } from './budget.js'
export { getBudget } from './budget.js'

export class ContextEngine {
  private nCtx: number
  private systemMessage: Message | null = null
  private selector: FileSelector
  private scanner: RepoScanner
  private indexer: RepoIndexer
  private indexFingerprint = ''
  private scanCache: { rootPath: string; result: ScanResult } | null = null
  private static readonly MAX_CONTEXT_FILES = 6

  constructor(nCtx = 8192) {
    this.nCtx = nCtx
    this.selector = new FileSelector()
    this.scanner = new RepoScanner()
    this.indexer = new RepoIndexer()
  }

  setSystemMessage(msg: Message): void {
    this.systemMessage = msg
  }

  invalidateCache(): void {
    this.scanCache = null
    this.indexFingerprint = ''
  }

  private ensureScanned(rootPath?: string): ScanResult {
    const dir = rootPath ?? process.cwd()
    if (!this.scanCache || this.scanCache.rootPath !== dir) {
      const result = this.scanner.scan({ rootPath: dir, maxDepth: 8, maxSizeBytes: 1_048_576 })
      this.scanCache = { rootPath: dir, result }
    }
    return this.scanCache.result
  }

  getProjectFingerprint(rootPath?: string): string {
    const result = this.ensureScanned(rootPath)
    const pairs: string[] = []
    function walk(nodes: FileNode[], prefix: string) {
      for (const n of nodes) {
        const p = prefix ? prefix + '/' + n.name : n.name
        if (n.type === 'dir') walk(n.children ?? [], p)
        else pairs.push(`${p}:${n.size}`)
      }
    }
    walk(result.root.children ?? [], '')
    pairs.sort()
    return createHash('md5').update(pairs.join('|')).digest('hex')
  }

  getAllFiles(rootPath?: string): string[] {
    const result = this.ensureScanned(rootPath)
    return buildFlatList(result)
  }

  getProjectTree(rootPath?: string, maxDepth = 4): string {
    const result = this.ensureScanned(rootPath)
    const dir = rootPath ?? process.cwd()
    const allPaths = new Set(buildFlatList(result))
    return buildCompactTree(result.root, maxDepth, dir.replace(/\\/g, '/'), allPaths)
  }

  ensureIndex(rootPath?: string, onProgress?: (evt: ThinkingProgressEvent) => void): void {
    const dir = rootPath ?? process.cwd()
    this.indexer.setRootPath(dir)
    const fingerprint = this.getProjectFingerprint(dir)
    if (this.indexer.isBuilt && this.indexFingerprint === fingerprint) return

    const indexDir = join(dir, '.locus', 'index')
    onProgress?.({ stage: 'Loading index', elapsedMs: 0 })
    if (this.indexer.load(indexDir, fingerprint)) {
      this.indexFingerprint = fingerprint
      return
    }

    const result = this.ensureScanned(dir)
    const allFiles = buildFlatList(result)
    if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true })
    this.indexer.build(allFiles, dir, fingerprint)
    this.indexer.save(indexDir)
    this.indexFingerprint = fingerprint
  }

  async selectContext(
    query: string,
    rootPath?: string,
    onProgress?: (evt: ThinkingProgressEvent) => void,
  ): Promise<string> {
    const dir = rootPath ?? process.cwd()
    const started = Date.now()
    const emit = (stage: ThinkingStage, detail?: string) => onProgress?.({ stage, elapsedMs: Date.now() - started, detail })
    const budget = getBudget(this.nCtx)
    const budgetChars = budget.context * 4

    emit('Scanning project')
    this.ensureScanned(dir)
    const allFiles = buildFlatList(this.scanCache!.result)

    emit('Loading index')
    this.ensureIndex(dir, onProgress)
    emit('Selecting symbols')
    const chunks = this.indexer.search(query, ContextEngine.MAX_CONTEXT_FILES)
    emit('Scoring matches', `${chunks.length} chunks`)
    const fromIndex = chunks.length > 0

    if (!fromIndex) {
      const pathRelevant = this.selector.selectRelevant(query, allFiles, ContextEngine.MAX_CONTEXT_FILES)
      if (pathRelevant.length === 0) return ''
      emit('Building context')
      return this.assembleFromPaths(pathRelevant, budgetChars)
    }

    const relevantPaths = new Set(chunks.map(c => c.chunk.filePath))
    const rootDir = this.scanCache!.rootPath
    const tree = buildCompactTree(this.scanCache!.result.root, 3, rootDir.replace(/\\/g, '/'), relevantPaths)
    const parts: string[] = []
    let totalChars = 0

    if (tree) {
      const treeBlock = `Project structure:\n${tree}\n`
      parts.push(treeBlock)
      totalChars += treeBlock.length
    }

    emit('Building context')
    for (const sc of chunks) {
      const c = this.hydrateChunk(sc.chunk, dir)
      const lang = detectLanguageFromPath(c.filePath)
      const header = c.label ? `# ${c.filePath}:${c.startLine} (${c.label})` : `# ${c.filePath}:${c.startLine}`
      const content = c.content ?? ''
      const block = `\n${header}\n\`\`\`${lang}\n${content}\n\`\`\`\n`

      if (totalChars + block.length > budgetChars) {
        if (totalChars === 0) {
          const remaining = budgetChars - totalChars
          const trimmed = block.slice(0, remaining) + '\n```\n'
          parts.push(trimmed)
        }
        break
      }

      parts.push(block)
      totalChars += block.length
    }

    return parts.join('\n').trim()
  }

  async suggestContext(
    query: string,
    rootPath?: string,
    onProgress?: (evt: ThinkingProgressEvent) => void,
  ): Promise<{ suggestions: string; tree: string }> {
    const dir = rootPath ?? process.cwd()
    const started = Date.now()
    const emit = (stage: ThinkingStage, detail?: string) => onProgress?.({ stage, elapsedMs: Date.now() - started, detail })

    emit('Scanning project')
    this.ensureScanned(dir)
    const allFiles = buildFlatList(this.scanCache!.result)

    emit('Loading index')
    this.ensureIndex(dir, onProgress)
    emit('Selecting symbols')
    const chunks = this.indexer.search(query, ContextEngine.MAX_CONTEXT_FILES)
    const fromIndex = chunks.length > 0

    let suggestedFiles: string[]
    if (fromIndex) {
      suggestedFiles = [...new Set(chunks.map(c => c.chunk.filePath))]
    } else {
      const pathRelevant = this.selector.selectRelevant(query, allFiles, ContextEngine.MAX_CONTEXT_FILES)
      suggestedFiles = pathRelevant.map(f => f.filePath)
    }

    if (suggestedFiles.length === 0) return { suggestions: '', tree: '' }

    const relevantPaths = new Set(suggestedFiles)
    const rootDir = this.scanCache!.rootPath
    const tree = buildCompactTree(this.scanCache!.result.root, 3, rootDir.replace(/\\/g, '/'), relevantPaths)

    const lines: string[] = []
    for (const fp of suggestedFiles) {
      const label = chunks.find(c => c.chunk.filePath === fp)?.chunk.label
      if (label) {
        lines.push(`- \`${fp}\` — contains ${label}`)
      } else {
        lines.push(`- \`${fp}\``)
      }
    }

    return { suggestions: lines.join('\n'), tree: tree || '' }
  }

  private hydrateChunk(chunk: import('../../repo/types.js').IndexChunk, rootPath: string): import('../../repo/types.js').IndexChunk {
    if (chunk.content && chunk.content.length > 0) return chunk
    const fullPath = join(rootPath, chunk.filePath)
    try {
      const text = readFileSync(fullPath, 'utf-8')
      const lines = text.split('\n')
      const start = Math.max(0, chunk.startLine - 1)
      const end = Math.min(lines.length, chunk.endLine)
      return { ...chunk, content: lines.slice(start, end).join('\n') }
    } catch {
      return { ...chunk, content: '' }
    }
  }

  private assembleFromPaths(files: import('./selector.js').FileScore[], budgetChars: number): string {
    const parts: string[] = []
    let totalChars = 0

    for (const file of files) {
      try {
        const content = readFileSync(file.filePath, 'utf-8')
        const lang = detectLanguageFromPath(file.filePath)
        const truncated = truncateSmart(content, file.filePath, 200)
        const header = `# ${file.filePath}`
        const block = `\n${header}\n\`\`\`${lang}\n${truncated.content}\n\`\`\`\n`

        if (totalChars + block.length > budgetChars) {
          if (totalChars === 0) {
            const remaining = budgetChars - totalChars
            const trimmed = block.slice(0, remaining) + '\n```\n'
            parts.push(trimmed)
          }
          break
        }

        parts.push(block)
        totalChars += block.length
      } catch {
        continue
      }
    }

    return parts.join('\n').trim()
  }

  prune(messages: Message[]): Message[] {
    const budget = getBudget(this.nCtx)
    const trimmed = trimHistoryToBudget(messages, budget, this.systemMessage)
    if (this.systemMessage) trimmed.unshift(this.systemMessage)
    return trimmed
  }

  pruneWithContext(messages: Message[], fileContext: string): Message[] {
    const contextTokenEstimate = estimateTokens(fileContext)
    const budget = getBudget(this.nCtx)
    const adjustedHistory = budget.history - contextTokenEstimate
    const historyBudget = Math.max(adjustedHistory, 500)

    const trimmed = trimHistoryToBudget(
      messages,
      { ...budget, history: historyBudget },
      this.systemMessage,
    )

    if (this.systemMessage) trimmed.unshift(this.systemMessage)
    return trimmed
  }

  truncateToolResult(result: string): string {
    return truncateToTokens(result, 500)
  }
}

function buildCompactTree(root: FileNode, maxDepth: number, rootDir: string, relevantPaths: Set<string>): string {
  const lines: string[] = []
  function relMatch(dirPath: string): boolean {
    return [...relevantPaths].some(rp => {
      const parts = rp.replace(rootDir, '').replace(/^\/+/, '').split('/')
      const rel = parts.slice(0, -1).join('/')
      return rel.startsWith(dirPath)
    })
  }
  function walk(nodes: FileNode[], prefix: string, depth: number, treePrefix: string) {
    if (depth > maxDepth) return
    const visible = nodes.filter(n => {
      if (n.type === 'dir') return depth < 2 || relMatch(prefix ? prefix + '/' + n.name : n.name)
      return depth < 1
    })
    for (let i = 0; i < visible.length; i++) {
      const n = visible[i]
      const isLast = i === visible.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? '    ' : '│   '
      const p = prefix ? prefix + '/' + n.name : n.name
      if (n.type === 'dir') {
        lines.push(treePrefix + connector + n.name + '/')
        if (depth < maxDepth) walk(n.children ?? [], p, depth + 1, treePrefix + childPrefix)
      } else {
        lines.push(treePrefix + connector + n.name)
      }
    }
  }
  walk(root.children ?? [], '', 0, '')
  return lines.join('\n')
}

function detectLanguageFromPath(filePath: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    vue: 'vue', svelte: 'svelte', astro: 'astro',
    css: 'css', scss: 'scss', html: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', md: 'markdown',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    dockerfile: 'dockerfile', makefile: 'makefile',
    tf: 'terraform', toml: 'toml',
  }
  const i = filePath.lastIndexOf('.')
  if (i < 0) return ''
  const ext = filePath.slice(i + 1).toLowerCase()
  return map[ext] ?? ext
}
