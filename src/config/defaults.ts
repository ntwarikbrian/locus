const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'
const DEFAULT_MODEL = 'qwen2.5-coder-3b-instruct'

export interface AppConfig {
  baseURL: string
  model: string
  temperature: number
  maxTokens: number
  storageDir: string
  host: string
  port: number
  modelPath: string
  binaryPath: string
  nCtx: number
  nGpuLayers: number
  verbose: boolean
  authUrl: string
  authTimeoutMs: number
  authMaxRetries: number
  disableLicenseGate: boolean
  convexSharedSecret?: string
}

export const defaults: AppConfig = {
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  temperature: 0.1,
  maxTokens: 4096,
  storageDir: '',
  host: '127.0.0.1',
  port: 8080,
  modelPath: '',
  binaryPath: '',
  nCtx: 8192,
  nGpuLayers: 0,
  verbose: false,
  authUrl: 'https://api.locus.ai/v1/activate',
  authTimeoutMs: 30000,
  authMaxRetries: 3,
  disableLicenseGate: false,
}
