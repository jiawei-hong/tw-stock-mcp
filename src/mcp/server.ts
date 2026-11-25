import { createProgressReporter, type Notify, progressToken } from './progress.js'
import { type JsonSchema, validate } from './schema.js'

export type { JsonRpcNotification, Notify } from './progress.js'

/**
 * Hand-rolled MCP server core (JSON-RPC 2.0), independent of the transport.
 * Implements the subset a read-only tools server needs: initialize, ping,
 * tools/list, tools/call, request cancellation, progress notifications and,
 * when configured, prompts (list, get) and read-only resources (list, read).
 */

/** Newest first. The first entry is offered when the client asks for an unknown version. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const

/** Protocol versions that understand `outputSchema` / `structuredContent`. */
const STRUCTURED_OUTPUT_VERSIONS = new Set(['2025-11-25', '2025-06-18'])

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** MCP: resources/read for a URI the server does not have. */
  RESOURCE_NOT_FOUND: -32002,
} as const

type Id = string | number

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: Id | null; result: unknown }
  | {
      jsonrpc: '2.0'
      id: Id | null
      error: { code: number; message: string; data?: unknown }
    }

export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type ToolContext = {
  signal: AbortSignal
  /**
   * Reports progress on a slow call. Sends notifications/progress only when the
   * request carried `_meta.progressToken`, and does nothing otherwise. Values
   * must increase; updates are throttled to one per ~100 ms per request and
   * none are sent after the response.
   */
  progress?: (progress: number, total?: number, message?: string) => void
}

export type HandleOptions = {
  /** Sends a server-to-client notification on the transport that carried the message. */
  notify?: Notify
}

export type Tool<Input = Record<string, unknown>> = {
  name: string
  title: string
  description: string
  inputSchema: Extract<JsonSchema, { type: 'object' }>
  /** Published as-is; describes `structuredContent`. */
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
  run(input: Input, context: ToolContext): Promise<Record<string, unknown>>
}

/** An error whose message is written for the calling agent to act on. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export type PromptArgument = {
  name: string
  description: string
  required?: boolean
}

export type Prompt = {
  name: string
  title: string
  description: string
  arguments: readonly PromptArgument[]
  /**
   * Returns the text of the user message. Receives only the declared arguments,
   * trimmed, with blank optional ones left out. Throw PromptError for a value
   * the client should correct.
   */
  render(args: Record<string, string>): string
}

export type Resource = {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  /** Returns the current contents as text. */
  read(signal: AbortSignal): Promise<string>
}

/** A prompt argument the client has to fix; reported as invalid params. */
export class PromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptError'
  }
}

export type ServerOptions = {
  name: string
  title?: string
  version: string
  instructions?: string
  // Each tool's run() is typed by its own input; the server validates before calling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: readonly Tool<any>[]
  /** The prompts capability is advertised only when this is non-empty. */
  prompts?: readonly Prompt[]
  /** The resources capability (without subscribe or listChanged) is advertised only when this is non-empty. */
  resources?: readonly Resource[]
  log?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' || typeof value === 'number'
}

function failure(
  id: Id | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class McpServer {
  private readonly tools: Map<string, Tool<Record<string, unknown>>>
  private readonly prompts: Map<string, Prompt>
  private readonly resources: Map<string, Resource>
  private readonly inFlight = new Map<Id, AbortController>()
  private protocolVersion: string = SUPPORTED_PROTOCOL_VERSIONS[0]

  constructor(private readonly options: ServerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]))
    this.prompts = new Map((options.prompts ?? []).map((prompt) => [prompt.name, prompt]))
    this.resources = new Map((options.resources ?? []).map((resource) => [resource.uri, resource]))
  }

  /**
   * Handles one parsed JSON-RPC message (or batch). Resolves to the response to
   * send, or `undefined` for notifications. Notifications about a request (such
   * as progress) go through `options.notify` before the response resolves.
   */
  async handle(
    message: unknown,
    options: HandleOptions = {}
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return failure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Empty batch')
      }
      const responses = await Promise.all(
        message.map((entry) => this.handleOne(entry, options))
      )
      const sent = responses.filter(
        (response): response is JsonRpcResponse => response !== undefined
      )
      return sent.length ? sent : undefined
    }
    return this.handleOne(message, options)
  }

  private async handleOne(
    message: unknown,
    options: HandleOptions
  ): Promise<JsonRpcResponse | undefined> {
    if (
      !isRecord(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    ) {
      // Responses from the client (we never send requests) are ignored.
      if (isRecord(message) && ('result' in message || 'error' in message)) {
        return undefined
      }
      const id = isRecord(message) && isId(message.id) ? message.id : null
      return failure(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid request')
    }

    const params = isRecord(message.params) ? message.params : {}
    if (!('id' in message) || message.id === undefined) {
      this.handleNotification(message.method, params)
      return undefined
    }
    if (!isId(message.id)) {
      return failure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid id')
    }

    const id = message.id
    try {
      const result = await this.dispatch(id, message.method, params, options)
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (error instanceof RpcError) {
        return failure(id, error.code, error.message, error.data)
      }
      this.options.log?.(`internal error in ${message.method}: ${errorMessage(error)}`)
      return failure(id, JSON_RPC_ERRORS.INTERNAL_ERROR, errorMessage(error))
    }
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    if (method === 'notifications/cancelled' && isId(params.requestId)) {
      this.inFlight.get(params.requestId)?.abort(
        new Error(
          typeof params.reason === 'string' ? params.reason : 'Request cancelled'
        )
      )
    }
    // notifications/initialized and anything else need no action.
  }

  private async dispatch(
    id: Id,
    method: string,
    params: Record<string, unknown>,
    options: HandleOptions
  ): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: [...this.tools.values()].map((tool) => this.describe(tool)) }
      case 'tools/call':
        return this.callTool(id, params, options)
      case 'prompts/list':
        if (!this.prompts.size) break
        return { prompts: [...this.prompts.values()].map(describePrompt) }
      case 'prompts/get':
        if (!this.prompts.size) break
        return this.getPrompt(params)
      case 'resources/list':
        if (!this.resources.size) break
        return { resources: [...this.resources.values()].map(describeResource) }
      case 'resources/templates/list':
        if (!this.resources.size) break
        return { resourceTemplates: [] }
      case 'resources/read':
        if (!this.resources.size) break
        return this.readResource(id, params)
    }
    throw new RpcError(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  private initialize(params: Record<string, unknown>) {
    const requested = params.protocolVersion
    this.protocolVersion =
      typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0]

    return {
      protocolVersion: this.protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        ...(this.prompts.size ? { prompts: { listChanged: false } } : {}),
        ...(this.resources.size ? { resources: {} } : {}),
      },
      serverInfo: {
        name: this.options.name,
        ...(this.options.title ? { title: this.options.title } : {}),
        version: this.options.version,
      },
      ...(this.options.instructions
        ? { instructions: this.options.instructions }
        : {}),
    }
  }

  private get structuredOutput(): boolean {
    return STRUCTURED_OUTPUT_VERSIONS.has(this.protocolVersion)
  }

  private describe(tool: Tool<Record<string, unknown>>) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema && this.structuredOutput
        ? { outputSchema: tool.outputSchema }
        : {}),
      ...(tool.annotations
        ? { annotations: { title: tool.title, ...tool.annotations } }
        : {}),
    }
  }

  private async callTool(
    id: Id,
    params: Record<string, unknown>,
    options: HandleOptions
  ) {
    const name = params.name
    const tool = typeof name === 'string' ? this.tools.get(name) : undefined
    if (!tool) {
      throw new RpcError(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Unknown tool: ${String(name)}. Available: ${[...this.tools.keys()].join(', ')}`
      )
    }

    const input = params.arguments ?? {}
    // Bad arguments are reported as a tool error so the model can correct itself.
    const problems = validate(tool.inputSchema, input)
    if (problems.length) {
      return this.errorResult(`Invalid arguments: ${problems.join('; ')}`)
    }

    const controller = new AbortController()
    const progress = createProgressReporter(progressToken(params), options.notify)
    this.inFlight.set(id, controller)
    try {
      const data = await tool.run(input as Record<string, unknown>, {
        signal: controller.signal,
        progress: progress.report,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        ...(this.structuredOutput ? { structuredContent: data } : {}),
      }
    } catch (error) {
      if (!(error instanceof ToolError)) {
        this.options.log?.(`tool ${tool.name} failed: ${errorMessage(error)}`)
      }
      return this.errorResult(errorMessage(error))
    } finally {
      // Before the response is returned, so no progress can follow it.
      progress.close()
      this.inFlight.delete(id)
    }
  }

  private errorResult(message: string) {
    return { content: [{ type: 'text', text: message }], isError: true }
  }

  private async readResource(id: Id, params: Record<string, unknown>) {
    const uri = params.uri
    if (typeof uri !== 'string') {
      throw new RpcError(JSON_RPC_ERRORS.INVALID_PARAMS, 'resources/read needs a uri')
    }
    const resource = this.resources.get(uri)
    if (!resource) {
      throw new RpcError(JSON_RPC_ERRORS.RESOURCE_NOT_FOUND, 'Resource not found', { uri })
    }
    const controller = new AbortController()
    this.inFlight.set(id, controller)
    try {
      const text = await resource.read(controller.signal)
      return { contents: [{ uri, mimeType: resource.mimeType, text }] }
    } finally {
      this.inFlight.delete(id)
    }
  }

  private getPrompt(params: Record<string, unknown>) {
    const name = params.name
    const prompt = typeof name === 'string' ? this.prompts.get(name) : undefined
    if (!prompt) {
      throw new RpcError(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Unknown prompt: ${String(name)}. Available: ${[...this.prompts.keys()].join(', ')}`
      )
    }

    const given = params.arguments ?? {}
    if (!isRecord(given)) {
      throw new RpcError(JSON_RPC_ERRORS.INVALID_PARAMS, 'Prompt arguments must be an object of strings')
    }
    const known = prompt.arguments.map((argument) => argument.name)
    const args: Record<string, string> = {}
    const problems: string[] = []
    for (const [key, value] of Object.entries(given)) {
      if (!known.includes(key)) {
        problems.push(`${key} is not an argument of ${prompt.name} (known: ${known.join(', ') || 'none'})`)
      } else if (typeof value === 'string') {
        // Clients often send optional arguments the user left empty as "".
        if (value.trim()) args[key] = value.trim()
      } else if (value !== null && value !== undefined) {
        problems.push(`${key} must be a string`)
      }
    }
    for (const argument of prompt.arguments) {
      const value = given[argument.name]
      const blank = value === undefined || value === null || typeof value === 'string'
      if (argument.required && args[argument.name] === undefined && blank) {
        problems.push(`${argument.name} is required`)
      }
    }
    const invalid = (reasons: string[]) =>
      new RpcError(
        JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid arguments for prompt ${prompt.name}: ${reasons.join('; ')}`
      )
    if (problems.length) throw invalid(problems)

    let text: string
    try {
      text = prompt.render(args)
    } catch (error) {
      throw error instanceof PromptError ? invalid([error.message]) : error
    }
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    }
  }
}

function describeResource({ uri, name, title, description, mimeType }: Resource) {
  return { uri, name, title, description, mimeType }
}

function describePrompt(prompt: Prompt) {
  return {
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map(({ name, description, required }) => ({
      name,
      description,
      required: required === true,
    })),
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}
