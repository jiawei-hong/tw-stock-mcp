import { parseCli } from '../src/cli.js'

describe('parseCli', () => {
  it('defaults to stdio', () => {
    expect(parseCli([])).toEqual({ mode: 'stdio' })
  })

  it('reads help and version flags', () => {
    expect(parseCli(['--help'])).toEqual({ mode: 'help' })
    expect(parseCli(['-h'])).toEqual({ mode: 'help' })
    expect(parseCli(['--version'])).toEqual({ mode: 'version' })
    expect(parseCli(['-v'])).toEqual({ mode: 'version' })
    expect(parseCli(['--http', '--help'])).toEqual({ mode: 'help' })
  })

  it('starts HTTP on 127.0.0.1:8886 unless told otherwise', () => {
    expect(parseCli(['--http'])).toEqual({ mode: 'http', port: 8886, host: '127.0.0.1', allowedOrigins: [] })
    expect(parseCli(['--http', '9000', '--host', '0.0.0.0'])).toEqual({
      mode: 'http',
      port: 9000,
      host: '0.0.0.0',
      allowedOrigins: [],
    })
    expect(parseCli(['--host=::1', '--http=0'])).toMatchObject({ mode: 'http', port: 0, host: '::1' })
  })

  it('collects allowed origins from repeated and comma-separated flags', () => {
    expect(
      parseCli(['--http', '--allow-origin', 'https://a.example, https://b.example', '--allow-origin=https://c.example'])
    ).toMatchObject({ allowedOrigins: ['https://a.example', 'https://b.example', 'https://c.example'] })
  })

  it('rejects bad ports, missing values, HTTP options without --http and unknown arguments', () => {
    expect(parseCli(['--http', 'abc'])).toEqual({
      mode: 'error',
      message: '--http expects a port from 0 to 65535, got "abc"',
    })
    expect(parseCli(['--http', '70000'])).toMatchObject({ mode: 'error' })
    expect(parseCli(['--http', '--host'])).toMatchObject({ mode: 'error', message: expect.stringContaining('--host') })
    expect(parseCli(['--host', '127.0.0.1'])).toEqual({
      mode: 'error',
      message: '--host and --allow-origin need --http',
    })
    expect(parseCli(['--verbose'])).toEqual({ mode: 'error', message: 'Unknown argument: --verbose' })
  })
})
