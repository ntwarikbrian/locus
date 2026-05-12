export interface IndexChunk {
  id: string
  filePath: string
  content?: string
  startLine: number
  endLine: number
  language: string
  label?: string
  imports?: string[]
  exportNames?: string[]
  keywords?: string[]
}

export interface ScoredChunk {
  chunk: IndexChunk
  score: number
}

export interface InvertedIndexData {
  fingerprint: string
  totalChunks: number
  chunks: IndexChunk[]
  postings: Record<string, { chunkIndex: number; tf: number }[]>
  docCount: number
  avgDocLen: number
}

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'arrow' | 'decorator' | 'field'

export interface SymbolRefV2 {
  name: string
  kind: SymbolKind
  signature: string
  filePath: string
  startLine: number
  endLine: number
  chunkIndex: number
  docPreview?: string
  exported?: boolean
}

export interface ChunkEntryV2 {
  id: string
  filePath: string
  startLine: number
  endLine: number
  language: string
  label?: string
  docLen: number
  pathBoostBase: number
  imports?: string[]
  exportNames?: string[]
  keywords?: string[]
}

export interface ChunkShardV2 {
  version: 2
  fingerprint: string
  chunks: ChunkEntryV2[]
}

export interface TermPostingV2 {
  chunkIndex: number
  tf: number
}

export interface TermShardV2 {
  version: 2
  fingerprint: string
  postings: Record<string, TermPostingV2[]>
}

export interface SymbolShardV2 {
  version: 2
  fingerprint: string
  symbols: SymbolRefV2[]
}

export interface DepGraphShardV2 {
  version: 2
  fingerprint: string
  forward: Record<string, string[]>
  reverse: Record<string, string[]>
}

export interface XRefEntry {
  filePath: string
  chunkIndex: number
  line: number
}

export interface XRefShardV2 {
  version: 2
  fingerprint: string
  refs: Record<string, XRefEntry[]>
}

export interface IndexShardMetaV2 {
  file: string
  checksum: string
  sizeBytes: number
}

export interface IndexManifestV2 {
  version: 2
  fingerprint: string
  createdAt: string
  totalChunks: number
  fileCount: number
  docCount: number
  avgDocLen: number
  schema: 'manifest-shards-v2'
  shards: {
    terms: IndexShardMetaV2
    chunks: IndexShardMetaV2
    symbols: IndexShardMetaV2
    deps?: IndexShardMetaV2
    xrefs?: IndexShardMetaV2
  }
}

export interface IndexProgress {
  current: number
  total: number
  file: string
}

export interface IndexMeta {
  fingerprint: string
  fileCount: number
  chunkCount: number
  lastUpdated: string
  sizeBytes: number
}

export interface IndexBuildMetrics {
  scanMs: number
  buildMs: number
  saveMs: number
  loadMs: number
  firstQueryMs: number
  p95QueryMs: number
  manifestBytes: number
  shardsBytes: number
}

export type ThinkingStage =
  | 'Scanning project'
  | 'Loading index'
  | 'Selecting symbols'
  | 'Scoring matches'
  | 'Building context'
  | 'Generating response'
  | 'Thinking'
  | 'Reading file'
  | 'Running tool'

export interface ThinkingProgressEvent {
  stage: ThinkingStage
  elapsedMs: number
  detail?: string
}
