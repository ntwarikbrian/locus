import pc from 'picocolors'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { join } from 'path'
import { Orchestrator } from '../core/orchestrator.js'
import type { LLMProvider } from '../providers/types.js'
import { RuntimeManager } from '../runtime/manager.js'
import { runtimeBinaryPath, runtimeDir } from '../runtime/paths.js'
import { findModel } from '../providers/llamacpp/binary.js'
import { isRuntimeInstalled } from '../runtime/installer.js'
import { progressBar } from '../ui/progress.js'
import { verifyLicense } from '../auth/verification.js'
import { activateLicense } from '../auth/activation.js'
import { getConfig } from '../runtime/state.js'
import { IndexManager } from '../repo/index-manager.js'
import type { IndexProgress } from '../repo/types.js'
import {
  gradientLine, boxTop, boxLine, boxBottom,
  divider, commandEntry, sectionHeader,
  statusBadge, kvLine, relativeTime, ICON,
} from '../ui/theme.js'
import { ResponseFormatter } from '../ui/response-formatter.js'

const W = 40

const LOGO_LINES = [
  '  ██╗      ██████╗  ██████╗██╗   ██╗███████╗',
  '  ██║     ██╔═══██╗██╔════╝██║   ██║██╔════╝',
  '  ██║     ██║   ██║██║     ██║   ██║███████╗',
  '  ██║     ██║   ██║██║     ██║   ██║╚════██║',
  '  ███████╗╚██████╔╝╚██████╗╚██████╔╝███████║',
  '  ╚══════╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚══════╝',
]

function buildBanner(): string {
  const lines: string[] = ['']  
  for (const l of LOGO_LINES) lines.push(gradientLine(l))
  lines.push('')
  lines.push(boxTop(W))
  lines.push(boxLine(`${pc.bold('locus')} ${pc.dim('v0.1')}  ${ICON.sparkle}  Local AI Coding Terminal`, W))
  lines.push(boxBottom(W))
  lines.push('')
  return lines.join('\n')
}

const BANNER = buildBanner()

function buildHelp(): string {
  const lines: string[] = []
  lines.push(sectionHeader('Commands'))
  lines.push(divider(40))
  lines.push('')
  lines.push(pc.dim('    AI & Sessions'))
  lines.push(commandEntry('/help', 'Show this help menu'))
  lines.push(commandEntry('/new', 'Start a fresh session'))
  lines.push(commandEntry('/sessions', 'List saved sessions'))
  lines.push(commandEntry('/session <id>', 'Resume a session by ID'))
  lines.push(commandEntry('/clear', 'Clear the terminal screen'))
  lines.push('')
  lines.push(pc.dim('    Codebase'))
  lines.push(commandEntry('/index', 'Index codebase for context'))
  lines.push(commandEntry('/index benchmark', 'Run index benchmark timings'))
  lines.push(commandEntry('/tree', 'Show project file structure'))
  lines.push('')
  lines.push(pc.dim('    System'))
  lines.push(commandEntry('/setup', 'Install llama.cpp runtime'))
  lines.push(commandEntry('/activate <token>', 'Activate a license'))
  lines.push(commandEntry('/exit', 'Exit locus'))
  lines.push('')
  return lines.join('\n')
}

const HELP = buildHelp()

function buildHelpLimited(): string {
  const lines: string[] = []
  lines.push(sectionHeader('Commands'))
  lines.push(divider(40))
  lines.push('')
  lines.push(commandEntry('/activate <token>', 'Activate your license'))
  lines.push(commandEntry('/setup', 'Install llama.cpp runtime'))
  lines.push(commandEntry('/help', 'Show this help'))
  lines.push(commandEntry('/exit', 'Exit locus'))
  lines.push('')
  return lines.join('\n')
}

const HELP_LIMITED = buildHelpLimited()

function buildHelpUnconfigured(): string {
  const lines: string[] = []
  lines.push(sectionHeader('Commands'))
  lines.push(divider(40))
  lines.push('')
  lines.push(commandEntry('/setup', 'Install llama.cpp runtime'))
  lines.push(commandEntry('/activate <token>', 'Activate a license'))
  lines.push(commandEntry('/help', 'Show this help'))
  lines.push(commandEntry('/exit', 'Exit locus'))
  lines.push('')
  return lines.join('\n')
}

const HELP_UNCONFIGURED = buildHelpUnconfigured()

const ESC_BYTE = 27

function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min}min ${sec}s` : `${min}min`
}

function prompt(licensed: boolean, ready: boolean): string {
  if (!licensed) return `${pc.dim('[')}${pc.yellow('unlicensed')}${pc.dim(']')} ${pc.yellow('❯')} `
  if (!ready) return `${pc.dim('[')}${pc.yellow('no runtime')}${pc.dim(']')} ${pc.yellow('❯')} `
  return `${pc.cyan('locus')} ${pc.cyan('❯')} `
}

export class CLI {
  private orchestrator: Orchestrator
  private runtime: RuntimeManager | null = null
  private currentAbort: AbortController | null = null
  private licensed = false
  private ready = false
  private indexManager: IndexManager

  constructor(provider: LLMProvider, runtime?: RuntimeManager, ready = false) {
    this.orchestrator = new Orchestrator(provider)
    this.runtime = runtime ?? null
    this.ready = ready
    this.indexManager = new IndexManager()
  }

  async start(): Promise<void> {
    if (getConfig().disableLicenseGate || process.env.LOCUS_DISABLE_LICENSE_GATE === 'true') {
      this.licensed = true
    } else {
      const result = await verifyLicense()
      if (result.ok) {
        this.licensed = true
      } else {
        this.printLicenseError(result.code)
      }
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: prompt(this.licensed, this.ready),
    })

    process.stdout.write(BANNER + '\n')

    if (this.ready) {
      const mode = this.runtime?.isRunning ? 'local' : 'external'
      process.stdout.write(`  ${statusBadge('AI Ready', 'success')}  ${pc.dim(`(${mode})`)}\n\n`)
    }

    if (!this.licensed) {
      process.stdout.write(`  ${ICON.warning} ${pc.yellow('License required to unlock full features.')}\n\n`)
      process.stdout.write(HELP_LIMITED + '\n')
    } else if (!this.ready) {
      process.stdout.write(`  ${ICON.info} ${pc.yellow('No runtime detected.')} Run ${pc.green('/setup')} to get started.\n\n`)
      process.stdout.write(HELP_UNCONFIGURED + '\n')
    } else {
      process.stdout.write(`  ${pc.dim('Type a message to chat, or use / commands below.')}\n\n`)
      process.stdout.write(HELP + '\n')
    }

    if (this.licensed && this.ready) {
      this.autoIndexSilently()
    }

    rl.prompt()

    rl.on('line', async (line: string) => {
      const t = line.trim()
      if (!t) { rl.prompt(); return }

      if (t.startsWith('/')) {
        process.stdout.write('\n')
        await this.handleCommand(t, rl)
        rl.prompt()
        return
      }

      if (!this.licensed) {
        process.stdout.write(`  ${ICON.warning} ${pc.yellow('License required.')} Use ${pc.green('/activate')} or ${pc.green('/help')}.\n`)
        rl.prompt()
        return
      }

      if (!this.ready) {
        process.stdout.write(`  ${ICON.info} ${pc.yellow('No runtime.')} Use ${pc.green('/setup')} to install one.\n`)
        rl.prompt()
        return
      }

      process.stdout.write('\n')
      rl.pause()
      const ac = new AbortController()
      this.currentAbort = ac

      let escTimer: ReturnType<typeof setTimeout> | null = null
      let escHinted = false

      const showEscHint = () => {
        if (escHinted) return
        escHinted = true
        process.stderr.write(pc.dim('⏎ ESC again within 7s to cancel\n'))
      }

      const clearEscHint = () => {
        if (!escHinted) return
        escHinted = false
        process.stderr.write('\x1b[1A\x1b[2K\r')
      }

      const wasRaw = process.stdin.isRaw
      try { process.stdin.setRawMode(true) } catch { }
      process.stdin.resume()

      const onStdinData = (chunk: Buffer) => {
        if (chunk.length === 1 && chunk[0] === ESC_BYTE) {
          if (!escHinted) {
            showEscHint()
            escTimer = setTimeout(() => { clearEscHint(); escTimer = null }, 7000)
          } else {
            clearEscHint()
            if (escTimer) { clearTimeout(escTimer); escTimer = null }
            ac.abort()
          }
        }
      }

      process.stdin.on('data', onStdinData)

      try {
        process.stdout.write('\n')
        const formatter = new ResponseFormatter((text) => {
          process.stdout.write(text)
        })
        const startTime = Date.now()
        await this.orchestrator.runStream(t, (token) => {
          formatter.write(token)
        }, ac.signal)
        formatter.flush()
        const elapsed = Date.now() - startTime
        clearEscHint()

        process.stdout.write(`\n${pc.dim(formatDuration(elapsed))}\n`)

        const { used, max } = this.orchestrator.getContextUsage()
        const pct = max > 0 ? Math.round((used / max) * 100) : 0
        const ctxLabel = `ctx: ${used}/${max} (${pct}%)`
        const cols = process.stdout.columns || 80
        const pad = Math.max(0, cols - ctxLabel.length)
        process.stdout.write(' '.repeat(pad) + pc.dim(ctxLabel) + '\n')
      } catch (err: any) {
        clearEscHint()
        if (err.name === 'AbortError' || err.name === 'CanceledError') {
          process.stdout.write(pc.yellow('\nInterrupted.\n'))
        } else {
          process.stdout.write(pc.red(`\nError: ${err.message}\n`))
        }
      } finally {
        process.stdin.removeListener('data', onStdinData)
        if (escTimer) { clearTimeout(escTimer); escTimer = null }
        try { process.stdin.setRawMode(wasRaw ?? false) } catch { }
        process.stdin.pause()
        this.currentAbort = null
      }
      rl.prompt()
      rl.resume()
    })

    rl.on('SIGINT', () => {
      if (this.currentAbort) {
        this.currentAbort.abort()
      } else {
        rl.close()
      }
    })

    rl.on('close', () => {
      process.stdout.write('\n')
      process.stdout.write(divider(30) + '\n')
      process.stdout.write(`  ${pc.dim('Thanks for using')} ${pc.cyan('locus')}${pc.dim('.')} ${pc.dim('Goodbye!')}\n`)
      process.stdout.write(divider(30) + '\n\n')
      process.exit(0)
    })
  }

  private printLicenseError(code: string): void {
    const messages: Record<string, string> = {
      missing: 'No license found.',
      expired: 'Your license has expired.',
      device_mismatch: 'This license is bound to a different device.',
      invalid_signature: 'License verification failed.',
      malformed: 'License file is corrupted.',
    }
    process.stdout.write(`  ${ICON.warning} ${pc.yellow(messages[code] || 'License check failed.')}\n`)
  }

  private async handleCommand(cmd: string, rl: ReturnType<typeof createInterface>): Promise<void> {
    const parts = cmd.split(/\s+/)
    const command = parts[0].toLowerCase()

    if (!this.licensed && command !== '/help' && command !== '/activate' && command !== '/exit' && command !== '/quit' && command !== '/setup') {
      process.stdout.write(`  ${ICON.warning} ${pc.yellow('Not available in unlicensed mode.')} Try ${pc.green('/activate')} or ${pc.green('/help')}.\n`)
      return
    }

    if (!this.ready && this.licensed && command !== '/setup' && command !== '/help' && command !== '/exit' && command !== '/quit' && command !== '/activate' && command !== '/index' && command !== '/tree') {
      process.stdout.write(`  ${ICON.info} ${pc.yellow('AI features need a running runtime.')} Use ${pc.green('/setup')}.\n`)
      return
    }

    switch (command) {
      case '/help':
        if (!this.licensed) process.stdout.write(HELP_LIMITED)
        else if (!this.ready) process.stdout.write(HELP_UNCONFIGURED)
        else process.stdout.write(HELP)
        break

      case '/clear':
        if (!this.licensed) {
          process.stdout.write(`  ${ICON.warning} ${pc.yellow('Not available in unlicensed mode.')} Use ${pc.green('/activate')}.\n`)
          break
        }
        console.clear()
        process.stdout.write(BANNER + '\n')
        break

      case '/new':
        this.orchestrator.newSession()
        break

      case '/index':
        await this.handleIndex(rl, parts[1])
        break

      case '/tree':
        this.handleTree()
        break

      case '/sessions': {
        const sessions = this.orchestrator.listSessions()
        if (sessions.length === 0) {
          process.stdout.write(`  ${pc.dim('No saved sessions yet.')}\n`)
        } else {
          process.stdout.write(sectionHeader('Sessions') + '\n')
          process.stdout.write(divider(40) + '\n')
          for (const s of sessions) {
            const elapsed = Date.now() - new Date(s.createdAt).getTime()
            const ago = relativeTime(elapsed)
            process.stdout.write(`  ${pc.cyan(s.id)}  ${pc.dim(ago)}  ${pc.dim(`${s.turns} turns`)}\n`)
          }
        }
        break
      }

      case '/session': {
        let sessionId = parts[1]
        if (!sessionId) {
          process.stdout.write(`  ${ICON.info} ${pc.yellow('Usage:')} ${pc.green('/session <id>')}\n`)
          break
        }
        sessionId = sessionId.replace(/^<|>$/g, '')
        const ok = this.orchestrator.switchSession(sessionId)
        if (ok) {
          process.stdout.write(`  ${ICON.success} Resumed session ${pc.cyan(sessionId)}\n`)
        } else {
          process.stdout.write(`  ${ICON.error} Session ${pc.dim('"' + sessionId + '"')} not found.\n`)
        }
        break
      }

      case '/activate':
        await this.handleActivate(parts.slice(1).join(' '), rl)
        break

      case '/setup':
        await this.handleSetup(rl)
        break

      case '/exit':
      case '/quit':
        rl.close()
        break

      default:
        if (command.startsWith('/session') && command !== '/session') {
          const sessionId = command.slice(1)
          return this.handleCommand(`/session ${sessionId}`, rl)
        }
        process.stdout.write(`  ${ICON.error} ${pc.red('Unknown command:')} ${pc.dim(command)}  ${pc.dim('Try /help')}\n`)
    }
  }

  private async handleSetup(rl?: ReturnType<typeof createInterface>): Promise<void> {
    const mgr = this.runtime ?? new RuntimeManager()

    // ── Check engine state ──
    const engineInstalled = isRuntimeInstalled()
    process.stdout.write(sectionHeader('Setup') + '\n')
    process.stdout.write(divider(40) + '\n')
    if (engineInstalled) {
      process.stdout.write(kvLine('Engine', `${ICON.success} ${pc.green('installed')}  ${pc.dim(runtimeBinaryPath())}`) + '\n')
    } else {
      process.stdout.write(kvLine('Engine', `${ICON.warning} ${pc.yellow('not installed')}`) + '\n')
    }

    // ── Check model state ──
    const modelPath = findModel()
    const modelsDirPath = join(homedir(), '.locus', 'models')
    if (modelPath) {
      const name = modelPath.split(/[/\\]/).pop() ?? modelPath
      process.stdout.write(kvLine('Model', `${ICON.success} ${name}`) + '\n')
    } else {
      process.stdout.write(kvLine('Model', `${ICON.warning} ${pc.yellow('not found')}  ${pc.dim(`place .gguf in ${modelsDirPath}`)}`) + '\n')
    }

    // ── If engine needs install ──
    if (!engineInstalled) {
      if (!mgr.hasManifest) {
        process.stdout.write(`\n  ${ICON.error} ${pc.red('No runtime manifest found.')} Reinstall locus package.\n\n`)
        return
      }

      process.stdout.write('\n')

      let lastPhase = ''
      const ok = await mgr.downloadAndInstall((phase, fraction) => {
        if (phase === 'connecting') {
          const msg = `  Downloading AI engine... ${pc.dim('connecting...')}`
          process.stdout.write(`\r${msg.padEnd(60)}`)
          lastPhase = phase
        } else if (phase === 'download') {
          const msg = `  Downloading AI engine... ${progressBar(fraction)}`
          process.stdout.write(`\r${msg.padEnd(60)}`)
          lastPhase = phase
        } else if (phase === 'verify') {
          if (lastPhase !== 'verify') {
            process.stdout.write(`\r  Downloading AI engine... ${progressBar(1)}${' '.repeat(10)}\n`)
          }
          process.stdout.write(`\r  Verifying download...   ${progressBar(fraction)}`)
          lastPhase = phase
        } else if (phase === 'extract') {
          process.stdout.write(`\r  Verifying download...   ${progressBar(1)}${' '.repeat(10)}\n`)
          process.stdout.write('  Unpacking runtime...')
          lastPhase = phase
        }
      })

      if (ok && lastPhase === 'extract') {
        process.stdout.write(` ${ICON.success}\n\n`)
      } else if (!ok) {
        process.stdout.write('\n')
        process.stdout.write(`  ${ICON.warning} ${pc.yellow('Could not install runtime automatically.')}\n`)
        process.stdout.write(pc.dim('    Options:\n'))
        process.stdout.write(pc.dim(`    ${ICON.arrow} Retry with ${pc.green('/setup')}\n`))
        process.stdout.write(pc.dim(`    ${ICON.arrow} Manual extract to ${runtimeDir()}\n`))
        process.stdout.write('\n')
        return
      }
    }

    // ── Start engine ──
    const modelPath2 = findModel()
    if (!mgr.isRunning && mgr.isInstalled && modelPath2) {
      process.stdout.write(`  ${pc.dim('Starting local engine...')} `)
      try {
        const config = getConfig()
        await mgr.start({
          host: config.host,
          port: config.port,
          modelPath: modelPath2,
          nCtx: config.nCtx,
          nGpuLayers: config.nGpuLayers,
        })
        await mgr.waitForReady(120_000)

        await new Promise((r) => setTimeout(r, 2000))
        if (!mgr.isRunning) {
          process.stdout.write(`${ICON.error}\n`)
          process.stdout.write(`  ${ICON.warning} ${pc.yellow('Process exited unexpectedly (possibly blocked by antivirus).')}\n`)
          process.stdout.write(`  ${pc.dim('Add an exclusion for:')} ${runtimeDir()}\n`)
          process.stdout.write(`  ${pc.dim('Or set LOCUS_CLIENT_ONLY=1 and run llama-server manually.')}\n\n`)
          return
        }

        process.stdout.write(`${ICON.success}\n`)
        process.stdout.write(`  ${statusBadge('Local AI ready', 'success')}\n\n`)
        this.ready = true
        rl?.setPrompt(prompt(this.licensed, this.ready))
      } catch {
        process.stdout.write(`${ICON.error} ${pc.red('failed')}\n`)
        process.stdout.write(`  ${pc.dim('Use LOCUS_BASE_URL to connect to an external server.')}\n\n`)
      }
    } else if (!modelPath2) {
      process.stdout.write('\n')
      process.stdout.write(`  ${ICON.warning} ${pc.yellow('Model not found.')} Place a .gguf file and run ${pc.green('/setup')} again.\n`)
      process.stdout.write(`  ${pc.dim('Expected:')} ${join(homedir(), '.locus', 'models')}\n\n`)
    } else if (mgr.isRunning) {
      process.stdout.write(`  ${statusBadge('Local AI ready', 'success')}\n\n`)
      rl?.setPrompt(prompt(this.licensed, this.ready))
    }
  }

  private handleTree(): void {
    const tree = this.orchestrator.getProjectTree()
    if (!tree) {
      process.stdout.write(`  ${ICON.warning} ${pc.yellow('No project scanned yet.')} Run ${pc.green('/index')} first.\n`)
      return
    }
    process.stdout.write('\n')
    process.stdout.write(sectionHeader('Project Structure') + '\n')
    process.stdout.write(divider(40) + '\n')
    const lines = tree.split('\n')
    for (const line of lines) {
      const isDir = line.trimEnd().endsWith('/')
      const trimmed = line.replace(/[├└│─\s]/g, '')
      const indent = line.replace(trimmed.replace(/\/$/, ''), '')
      if (isDir) {
        const dirName = trimmed.replace(/\/$/, '')
        process.stdout.write(`  ${indent}${pc.bold(pc.cyan(dirName))}/\n`)
      } else {
        process.stdout.write(`  ${indent}${pc.white(trimmed)}\n`)
      }
    }
    process.stdout.write(divider(40) + '\n\n')
  }

  private async handleIndex(rl: ReturnType<typeof createInterface>, mode?: string): Promise<void> {
    const rootPath = process.cwd()
    const mgr = this.indexManager
    if ((mode ?? '').toLowerCase() === 'benchmark') {
      const bench = mgr.benchmark(rootPath)
      process.stdout.write(sectionHeader('Index Benchmark') + '\n')
      process.stdout.write(divider(40) + '\n')
      process.stdout.write(kvLine('Scan', pc.cyan(`${bench.scanMs} ms`)) + '\n')
      process.stdout.write(kvLine('Build', pc.cyan(`${bench.buildMs} ms`)) + '\n')
      process.stdout.write(kvLine('Save', pc.cyan(`${bench.saveMs} ms`)) + '\n')
      process.stdout.write(kvLine('Load', pc.cyan(`${bench.loadMs} ms`)) + '\n')
      process.stdout.write(kvLine('1st query', pc.cyan(`${bench.firstQueryMs} ms`)) + '\n')
      process.stdout.write(kvLine('P95 query', pc.cyan(`${bench.p95QueryMs} ms`)) + '\n')
      process.stdout.write(kvLine('Manifest', pc.cyan(`${bench.manifestBytes} bytes`)) + '\n')
      process.stdout.write(kvLine('Shards', pc.cyan(`${bench.shardsBytes} bytes`)) + '\n\n')
      return
    }

    const status = mgr.status(rootPath)

    process.stdout.write(sectionHeader('Locus Index') + '\n')
    process.stdout.write(divider(40) + '\n')

    const idxKind = status.kind === 'current' ? 'success' : status.kind === 'stale' ? 'warning' : 'error' as const
    const label = status.kind === 'current' ? 'Up-to-date' : status.kind === 'stale' ? 'Stale' : 'Not indexed'
    process.stdout.write(kvLine('Status', statusBadge(label, idxKind)) + '\n')

    if (status.meta) {
      process.stdout.write(kvLine('Files', `${pc.cyan(String(status.fileCount))} indexed`) + '\n')
      process.stdout.write(kvLine('Chunks', pc.cyan(String(status.chunkCount))) + '\n')
      if (status.lastUpdated) {
        const diff = Date.now() - new Date(status.lastUpdated).getTime()
        process.stdout.write(kvLine('Last', pc.dim(relativeTime(diff))) + '\n')
      }
      const size = status.sizeBytes > 1_000_000
        ? `${(status.sizeBytes / 1_000_000).toFixed(1)} MB`
        : `${(status.sizeBytes / 1000).toFixed(0)} KB`
      process.stdout.write(kvLine('Size', pc.dim(size)) + '\n')
    } else {
      const allFiles = mgr.scanFiles(rootPath)
      process.stdout.write(kvLine('Files', `${pc.cyan(String(allFiles.length))} total`) + '\n')
    }

    process.stdout.write(kvLine('Watch', mgr.isWatching ? statusBadge('Active', 'success') : pc.dim('○ Off')) + '\n')

    const needsIndex = status.kind !== 'current'
    if (needsIndex) {
      const excludedDirs = ['node_modules', '.git', 'dist', '.locus', '__pycache__', '.next', '.turbo', 'coverage']
      process.stdout.write(`\n  ${pc.dim('Excluded:')} ${pc.dim(excludedDirs.join(', '))}\n`)

      const answer = await new Promise<string>((resolve) => {
        rl.question(`\n  ${status.kind === 'stale' ? 'Re-index' : 'Index'} codebase? ${pc.dim('[Y/n]')} `, (a) => resolve(a.trim().toLowerCase()))
      })

      if (answer === 'n' || answer === 'no') {
        process.stdout.write(`  ${pc.yellow('Skipped.')}\n\n`)
        return
      }
      process.stdout.write('\n')
      this.renderIndexProgress({ current: 1, total: 1, file: '' }, true)
      const result = mgr.index(rootPath, (p) => this.renderIndexProgress(p, false))
      this.renderIndexProgress({ current: result.fileCount, total: result.fileCount, file: '' }, true)

      process.stdout.write(`\n  ${ICON.success} ${pc.green('Indexing complete')}\n`)
      process.stdout.write(`  ${pc.dim(`${result.fileCount} files`)} ${pc.dim('|')} ${pc.dim(`${result.chunkCount} chunks`)}\n`)

      mgr.startWatcher(rootPath, () => {
        mgr.rebuild(rootPath)
      })
      process.stdout.write(`  ${statusBadge('Watcher active', 'success')} ${pc.dim('(auto-rebuilds on changes)')}\n\n`)
    } else {
      process.stdout.write(`\n  ${pc.dim('Type /index again to force re-index.')}\n\n`)
    }
  }

  private autoIndexSilently(): void {
    const rootPath = process.cwd()
    const mgr = this.indexManager
    const status = mgr.status(rootPath)

    if (status.kind !== 'current') {
      const result = mgr.index(rootPath)
      process.stdout.write(`  ${pc.dim(`Indexed ${result.fileCount} files, ${result.chunkCount} chunks`)}\n`)
    }

    mgr.startWatcher(rootPath, () => {
      mgr.rebuild(rootPath)
    })
  }

  private renderIndexProgress(p: IndexProgress, done: boolean): void {
    if (p.total <= 0) return
    const pct = Math.round((done ? 1 : p.current / p.total) * 100)
    const bar = progressBar(done ? 1 : p.current / p.total)

    if (p.current === 1 && !done) {
      process.stdout.write(`\n`)
    }

    if (!done && p.current > 1) {
      process.stdout.write('\x1b[2A')
    }
    if (done) {
      process.stdout.write(`\r  Indexing: ${bar} 100%\x1b[K\n`)
      process.stdout.write(`  ${pc.dim('File:')} ${''.padEnd(50)}\x1b[K`)
    } else {
      process.stdout.write(`\r  Indexing: ${bar} ${pct}%\x1b[K\n`)
      process.stdout.write(`  ${pc.dim('File:')} ${p.file}\x1b[K`)
      process.stdout.write('\n')
      process.stdout.write('\x1b[1A')
    }
  }

  private async handleActivate(tokenArg: string, rl: ReturnType<typeof createInterface>): Promise<void> {
    let token = tokenArg.trim()

    if (!token) {
      token = await new Promise<string>((resolve) => {
        rl.question(`  ${pc.dim('Activation token:')} `, (answer) => resolve(answer.trim()))
      })
      if (!token) {
        process.stdout.write(`  ${ICON.warning} ${pc.yellow('No token provided.')}\n`)
        return
      }
    }

    process.stdout.write('\n')

    const result = await activateLicense(token, (status) => {
      process.stdout.write(`  ${pc.dim(ICON.arrow)} ${pc.dim(status)}\n`)
    })

    if (result.ok) {
      this.licensed = true
      rl.setPrompt(prompt(true, this.ready))
      process.stdout.write(`  ${ICON.success} ${pc.green('License activated successfully!')}\n`)
      if (result.warnings?.length) {
        for (const w of result.warnings) {
          process.stdout.write(`  ${ICON.warning} ${pc.yellow(w)}\n`)
        }
      }
      process.stdout.write('\n')
    } else {
      process.stdout.write(`  ${ICON.error} ${pc.red('Activation failed:')} ${result.message}\n\n`)
    }
  }
}
