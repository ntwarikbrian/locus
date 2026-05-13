import type { Tool } from '../types.js'
import { glob } from 'glob'

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.locus/**',
  '**/storage/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/target/**',
  '**/bin/Debug/**',
  '**/bin/Release/**',
  '**/obj/**',
]

export const globTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'DISCOVER files matching a glob pattern. Use this BEFORE reading files when you need to: find specific file types, locate files by name pattern, explore directory structure, or discover what files exist. Use patterns like: "src/**/*.ts" for TypeScript files, "**/*auth*" for auth-related files, "**/*.test.ts" for test files, "**/*.tsx" for React components. Returns file PATHS (not content) - use the "read" tool to inspect file contents after discovery.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g. "src/**/*.ts", "**/*auth*", "**/*.test.ts"). Use comma-separated patterns for multiple (e.g. "**/*auth*,**/*login*")',
          },
        },
        required: ['pattern'],
      },
    },
  },
  handler: async (args) => {
    const rawPattern = args.pattern as string
    if (!rawPattern) return 'Error: no pattern provided'

    try {
      const root = process.cwd()

      const patterns = rawPattern
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)

      const results: string[] = []

      for (const pattern of patterns) {
        const matches = await glob(pattern, {
          cwd: root,
          nodir: true,
          dot: false,
          ignore: IGNORE_PATTERNS,
          absolute: false,
          windowsPathsNoEscape: true,
        })
        results.push(...matches)
      }

      const uniqueResults = [...new Set(results)]

      if (uniqueResults.length === 0) {
        return `(no matches found for pattern: ${rawPattern})`
      }

      uniqueResults.sort()

      return uniqueResults.join('\n')
    } catch (err: any) {
      return `Error: ${err.message}`
    }
  },
}
