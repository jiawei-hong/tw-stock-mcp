import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from './mcp/http.js'

/** What the command line asks for. stdio stays the default mode. */
export type CliCommand =
  | { mode: 'stdio' }
  | { mode: 'http'; port: number; host: string; allowedOrigins: string[] }
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'error'; message: string }

function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined
  const port = Number(value)
  return port <= 65_535 ? port : undefined
}

/** Parses the arguments after the script name. Flags also accept `--flag=value`. */
export function parseCli(args: readonly string[]): CliCommand {
  let http = false
  let port = DEFAULT_HTTP_PORT
  let host: string | undefined
  const allowedOrigins: string[] = []
  const error = (message: string): CliCommand => ({ mode: 'error', message })

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)
    const next = () => {
      if (inline !== undefined) return inline
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) return undefined
      index += 1
      return value
    }

    switch (flag) {
      case '--help':
      case '-h':
        return { mode: 'help' }
      case '--version':
      case '-v':
        return { mode: 'version' }
      case '--http': {
        http = true
        const value = next()
        if (value === undefined) break
        const parsed = parsePort(value)
        if (parsed === undefined) return error(`--http expects a port from 0 to 65535, got "${value}"`)
        port = parsed
        break
      }
      case '--host': {
        const value = next()
        if (!value) return error('--host expects an address, e.g. 127.0.0.1')
        host = value
        break
      }
      case '--allow-origin': {
        const value = next()
        if (!value) return error('--allow-origin expects an origin, e.g. https://app.example.com')
        allowedOrigins.push(...value.split(',').map((origin) => origin.trim()).filter(Boolean))
        break
      }
      default:
        return error(`Unknown argument: ${arg}`)
    }
  }

  if (!http) {
    return host !== undefined || allowedOrigins.length ? error('--host and --allow-origin need --http') : { mode: 'stdio' }
  }
  return { mode: 'http', port, host: host ?? DEFAULT_HTTP_HOST, allowedOrigins }
}
