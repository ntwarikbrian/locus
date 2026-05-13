import type { Tool } from '../types.js'
import { execSync } from 'child_process'

const MAX_GREP_MATCHES = 50
const GREP_TIMEOUT = 10000

interface GrepMatch {
  file: string
  line: number
  text: string
}

function parseGrepOutput(output: string): GrepMatch[] {
  const lines = output.trim().split('\n').filter(Boolean)
  const matches: GrepMatch[] = []

  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):(.*)$/)
    if (match) {
      matches.push({
        file: match[1],
        line: parseInt(match[2], 10),
        text: match[3].trim(),
      })
    }
  }

  return matches
}

function formatMatches(matches: GrepMatch[], totalFound: number, maxShown: number): string {
  if (matches.length === 0) {
    return '(no matches)'
  }

  const lines: string[] = []
  lines.push(`--- Found ${totalFound} match${totalFound !== 1 ? 'es' : ''}`)
  if (totalFound > maxShown) {
    lines.push(`--- Showing first ${maxShown} matches (${totalFound - maxShown} truncated)`)
  }
  lines.push('')

  const uniqueFiles = new Map<string, GrepMatch[]>()
  for (const m of matches) {
    const existing = uniqueFiles.get(m.file) || []
    existing.push(m)
    uniqueFiles.set(m.file, existing)
  }

  for (const [file, fileMatches] of uniqueFiles) {
    lines.push(`--- ${file} ---`)
    for (const m of fileMatches) {
      lines.push(`[line ${m.line}]: ${m.text}`)
    }
    lines.push('')
  }

  if (totalFound > maxShown) {
    lines.push(`--- Use more specific patterns to narrow results ---`)
  }

  return lines.join('\n').trim()
}

export const grepTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for patterns. Uses ripgrep (fast) if available, otherwise falls back to git grep. Use this to: find where symbols/functions are used, trace code paths, locate auth/login/token handling, find API endpoints, discover imports/exports, and locate specific patterns in the codebase. Returns matching lines with file names and line numbers. Use glob FIRST to discover files, then grep to find patterns within them.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for. Examples: "auth|jwt|token", "useState|useEffect", "router\\.get|app\\.post"' },
          include: { type: 'string', description: 'File glob filter (e.g. "*.ts", "*.tsx", "src/**/*.ts")' },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
        },
        required: ['pattern'],
      },
    },
  },
  handler: async (args) => {
    const pattern = args.pattern as string
    if (!pattern) return 'Error: no pattern provided'

    const searchPath = (args.path as string) || '.'
    const include = args.include as string | undefined

    try {
      let cmd: string
      let useGitGrep = false

      try {
        execSync('rg --version', { stdio: 'ignore', timeout: 2000 })
        cmd = `rg -n --no-heading --color=never "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`
        if (include) cmd += ` -g "${include}"`
      } catch {
        useGitGrep = true
        const escapedPattern = pattern.replace(/"/g, '\\"')
        cmd = `git grep -n "${escapedPattern}" -- "${searchPath}"`
      }

      const output = execSync(cmd, { encoding: 'utf-8', timeout: GREP_TIMEOUT })

      if (!output || output.trim().length === 0) {
        return '(no matches)'
      }

      const allMatches = parseGrepOutput(output)
      const totalFound = allMatches.length

      if (totalFound === 0) {
        return '(no matches)'
      }

      const shownMatches = allMatches.slice(0, MAX_GREP_MATCHES)

      return formatMatches(shownMatches, totalFound, MAX_GREP_MATCHES)
    } catch (err: any) {
      if (err.status === 1 && !err.stdout && !err.stderr) {
        return '(no matches)'
      }
      if (err.code === 'ENOENT' || err.message?.includes('is not recognized')) {
        return 'Error: No grep tool available. Please install ripgrep (recommended) or ensure git is available.\nInstall ripgrep: winget install BurntSushi.ripgrep.MSVC (Windows) or brew install ripgrep (macOS)'
      }
      return `Error: ${err.message}`
    }
  },
}
