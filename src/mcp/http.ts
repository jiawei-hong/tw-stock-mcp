import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo, isIP } from 'node:net'

import type { JsonRpcNotification } from './progress.js'
import { JSON_RPC_ERRORS, type McpServer, SUPPORTED_PROTOCOL_VERSIONS } from './server.js'

/**
 * MCP Streamable HTTP transport (spec 2025-11-25, basic/transports) on node:http.
 *
 * - One endpoint, `/mcp`. POST takes one JSON-RPC message (or a batch, which
 *   2025-03-26 clients may send). A request is answered with application/json,
 *   or with text/event-stream once it has a notification (progress) to send
 *   before its response and the client accepts SSE.
 * - GET returns 405: the server starts no streams of its own, and streams are
 *   not resumable, so events carry no IDs.
 * - initialize opens a session (MCP-Session-Id) with its own McpServer, so the
 *   negotiated version and in-flight requests stay per client. DELETE ends a
 *   session; idle sessions expire.
 * - Origin must be a localhost origin or one in `allowedOrigins` (DNS rebinding).
 * - With a token, every request needs `Authorization: Bearer <token>`. A
 *   non-loopback host refuses to start without one.
 */

export const DEFAULT_HTTP_PORT = 8886
export const DEFAULT_HTTP_HOST = '127.0.0.1'
export const MCP_PATH = '/mcp'

const MAX_BODY_BYTES = 256 * 1024
const SESSION_IDLE_MS = 30 * 60_000
const MAX_SESSIONS = 100
/** JSON-RPC "server error" range, for failures of the HTTP layer itself. */
const TRANSPORT_ERROR = -32000
/** RFC 6750 b64token. */
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/

export type HttpOptions = {
  /** Builds the McpServer for a new session. */
  createServer: () => McpServer
  /** Default 8886; 0 picks a free port. */
  port?: number
  /** Default 127.0.0.1. */
  host?: string
  /** Bearer token every request must carry. Required when `host` is not loopback. */
  token?: string
  /** Browser origins accepted besides localhost ones, e.g. "https://app.example.com". */
  allowedOrigins?: readonly string[]
  maxBodyBytes?: number
  sessionIdleMs?: number
  maxSessions?: number
  log?: (message: string) => void
}

export type HttpHandle = {
  /** The MCP endpoint, e.g. http://127.0.0.1:8886/mcp. */
  url: string
  port: number
  /** Ends every session, aborting its requests, and stops listening. */
  close(): Promise<void>
}

type Session = { server: McpServer; lastSeen: number; active: number }

/** localhost, 127.0.0.0/8 and ::1 (also bracketed or IPv4-mapped). */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (name === 'localhost') return true
  if (isIP(name) === 4) return name.startsWith('127.')
  if (isIP(name) === 6) return name === '::1' || name.startsWith('::ffff:127.')
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const digest = (value: string) => createHash('sha256').update(value).digest()

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function mediaTypes(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.split(';')[0].trim().toLowerCase())
}

function parseOrigin(origin: string): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(origin)
  } catch {
    // reported below
  }
  if (!parsed || parsed.origin === 'null') {
    throw new Error(`Not an origin: "${origin}". Use the form https://app.example.com.`)
  }
  return parsed.origin
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/** An HTTP-level failure, with a JSON-RPC error body that has no id. */
function sendError(res: ServerResponse, status: number, message: string, code = TRANSPORT_ERROR): void {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message } })
}

function writeEvent(res: ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
}

/** Resolves to the body, or undefined once it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      if (size > limit) return
      size += chunk.length
      if (size > limit) resolve(undefined)
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('close', () => {
      if (!req.complete) reject(new Error('client closed the request'))
    })
  })
}

/** Ids of the requests in a message or batch; notifications and responses have none. */
function requestIds(message: unknown): (string | number)[] {
  return (Array.isArray(message) ? message : [message]).flatMap((entry) =>
    isRecord(entry) && typeof entry.method === 'string' && (typeof entry.id === 'string' || typeof entry.id === 'number')
      ? [entry.id]
      : []
  )
}

export async function serveHttp(options: HttpOptions): Promise<HttpHandle> {
  const host = options.host ?? DEFAULT_HTTP_HOST
  const token = options.token || undefined
  if (!token && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to listen on ${host} without a bearer token. Set TW_STOCK_MCP_TOKEN, or listen on 127.0.0.1.`
    )
  }
  if (token && !TOKEN_PATTERN.test(token)) {
    throw new Error('The bearer token may contain only letters, digits and -._~+/ (optionally ending in =).')
  }
  const expectedToken = token ? digest(token) : undefined
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(parseOrigin))
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS
  const maxSessions = options.maxSessions ?? MAX_SESSIONS
  const sessions = new Map<string, Session>()

  const endSession = (id: string, reason: string) => {
    sessions.get(id)?.server.cancelAll(reason)
    sessions.delete(id)
  }

  const findSession = (id: string): Session | undefined => {
    const session = sessions.get(id)
    if (session && session.active === 0 && Date.now() - session.lastSeen > sessionIdleMs) {
      endSession(id, 'Session expired')
      return undefined
    }
    return session
  }

  const originAllowed = (origin: string): boolean => {
    try {
      const url = new URL(origin)
      if (allowedOrigins.has(url.origin)) return true
      return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)
    } catch {
      return false
    }
  }

  const authorized = (value: string | undefined): boolean => {
    if (!expectedToken) return true
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value ?? '')
    return !!match && timingSafeEqual(digest(match[1]), expectedToken)
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaTypes(header(req, 'content-type'))[0] !== 'application/json') {
      return sendError(res, 415, 'Content-Type must be application/json')
    }
    const accepted = mediaTypes(header(req, 'accept'))
    const acceptsSse = accepted.includes('text/event-stream')
    const acceptsJson =
      !header(req, 'accept') || ['application/json', 'application/*', '*/*'].some((type) => accepted.includes(type))
    if (!acceptsJson && !acceptsSse) {
      return sendError(res, 406, 'Accept must list application/json and text/event-stream')
    }

    const tooLarge = () => {
      res.setHeader('Connection', 'close')
      sendError(res, 413, `Request body is larger than ${maxBodyBytes} bytes`)
    }
    if (Number(header(req, 'content-length')) > maxBodyBytes) return tooLarge()
    const body = await readBody(req, maxBodyBytes)
    if (body === undefined) return tooLarge()

    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return sendError(res, 400, 'Parse error', JSON_RPC_ERRORS.PARSE_ERROR)
    }

    const initialize = isRecord(message) && message.method === 'initialize'
    let sessionId = header(req, 'mcp-session-id')
    let session: Session | undefined
    if (initialize) {
      for (const id of [...sessions.keys()]) findSession(id)
      if (sessions.size >= maxSessions) {
        return sendError(res, 503, 'Too many open sessions. End one with DELETE, or retry later.')
      }
      sessionId = randomUUID()
      session = { server: options.createServer(), lastSeen: Date.now(), active: 0 }
    } else {
      if (!sessionId) return sendError(res, 400, 'Missing MCP-Session-Id header. Send initialize first.')
      session = findSession(sessionId)
      if (!session) return sendError(res, 404, 'Session not found or expired. Send initialize again.')
      const version = header(req, 'mcp-protocol-version')
      if (version !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        return sendError(res, 400, `Unsupported MCP-Protocol-Version: ${version}`)
      }
    }

    let streaming = false
    const startStream = () => {
      streaming = true
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' })
    }
    const notify = acceptsSse
      ? (notification: JsonRpcNotification) => {
          if (res.writableEnded || res.destroyed) return
          if (!streaming) startStream()
          writeEvent(res, notification)
        }
      : undefined

    // Streams are not resumable, so a response for a client that has gone can
    // never be delivered: cancel its requests instead of finishing the work.
    const server = session.server
    const ids = requestIds(message)
    const onClose = () => {
      if (res.writableFinished) return
      for (const requestId of ids) {
        void server.handle({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId, reason: 'Client disconnected' },
        })
      }
    }

    session.active += 1
    session.lastSeen = Date.now()
    res.on('close', onClose)
    let response: Awaited<ReturnType<McpServer['handle']>>
    try {
      response = await server.handle(message, { notify })
    } finally {
      res.off('close', onClose)
      session.active -= 1
      session.lastSeen = Date.now()
    }

    const opened = initialize && isRecord(response) && 'result' in response
    if (opened) sessions.set(sessionId!, session)
    if (res.destroyed) return
    if (response === undefined) {
      if (streaming) res.end()
      else res.writeHead(202).end()
      return
    }
    if (streaming || !acceptsJson) {
      if (!streaming) startStream()
      writeEvent(res, response)
      res.end()
      return
    }
    // A message that is not valid JSON-RPC is a bad request at the HTTP level too.
    const status =
      isRecord(response) && 'error' in response && response.error.code === JSON_RPC_ERRORS.INVALID_REQUEST ? 400 : 200
    sendJson(res, status, response, opened ? { 'MCP-Session-Id': sessionId! } : {})
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== MCP_PATH) {
      return sendError(res, 404, `Not found. The MCP endpoint is ${MCP_PATH}.`)
    }

    const origin = header(req, 'origin')
    if (origin !== undefined) {
      if (!originAllowed(origin)) return sendError(res, 403, `Origin not allowed: ${origin}`)
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id')
      res.setHeader('Vary', 'Origin')
    }
    // CORS preflight: browsers send it without credentials.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, DELETE',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }

    if (!authorized(header(req, 'authorization'))) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="tw-stock-mcp"')
      return sendError(res, 401, 'Missing or invalid bearer token')
    }

    if (req.method === 'POST') return handlePost(req, res)
    if (req.method === 'DELETE') {
      const id = header(req, 'mcp-session-id')
      if (!id) return sendError(res, 400, 'Missing MCP-Session-Id header')
      if (!findSession(id)) return sendError(res, 404, 'Session not found or expired')
      endSession(id, 'Session ended by the client')
      res.writeHead(204).end()
      return
    }
    res.setHeader('Allow', 'POST, DELETE, OPTIONS')
    return sendError(
      res,
      405,
      req.method === 'GET'
        ? 'This server opens no server-initiated stream. POST JSON-RPC messages to this endpoint.'
        : `Method not allowed: ${req.method}`
    )
  }

  const http = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      // readBody rejects when the client goes away mid-request; nothing to answer then.
      if (res.destroyed || req.destroyed) return
      options.log?.(`http error: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendError(res, 500, 'Internal server error', JSON_RPC_ERRORS.INTERNAL_ERROR)
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? DEFAULT_HTTP_PORT, host, () => {
      http.off('error', reject)
      resolve()
    })
  })

  const address = http.address() as AddressInfo
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `http://${shown}:${address.port}${MCP_PATH}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const id of [...sessions.keys()]) endSession(id, 'Server shutting down')
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  }
}
