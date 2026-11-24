import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ZodError } from 'zod'
import { TLSSocket } from 'node:tls'
import { isLoopback, normalizeRemote } from './sharing/network.js'
import { PasswordInput } from './sharing/password-input.js'
import { PasswordPairingError } from './sharing/password-pairing.js'
import { currentProfile } from './profile.js'
import { BaiduAccount } from './sharing/baidu.js'
import { SharingEngine } from './sharing/engine.js'
import { SharingStateFile, stateDirectory } from './sharing/state.js'
import type { SharingWorkspace } from './sharing/workspace.js'

export const name = 'chatds-sharing'
export const inject = ['chatdsSharingWorkspace', 'webServer', 'connection', 'credentials'] as const

const bodyLimit = 18 * 1024 * 1024
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const data of req.iterator({ destroyOnReturn: false })) {
    const chunk = data as Buffer
    size += chunk.length
    if (size > bodyLimit) throw new Error('Sharing request is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

export function apply(ctx: Context): void {
  const workspace = ctx.get('chatdsSharingWorkspace') as SharingWorkspace
  ctx.effect(() => {
    const profile = currentProfile(ctx)
    const engine = new SharingEngine(new SharingStateFile(stateDirectory(profile)), workspace, new BaiduAccount(ctx.credentials, profile))
    const passwordInput = new PasswordInput()
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: workspace.pagePath.replace(/\/+$/, '') + '/api/sharing',
      handler: async (req, res) => {
        if (ctx.connection.requestRejection(req) !== undefined) {
          send(res, 403, { error: { message: 'Forbidden' } })
          return
        }
        try {
          if (req.method === 'GET') {
            const view = new URL(req.url ?? '/', 'http://localhost').searchParams.get('view')
            if (view === 'password-input') {
              if (!(req.socket instanceof TLSSocket) && !isLoopback(normalizeRemote(req.socket.remoteAddress))) {
                throw new PasswordPairingError('请从本机 DSH 或 HTTPS 页面设置同步密码。')
              }
              send(res, 200, await passwordInput.issue())
              return
            }
            const result = await engine.status(view !== 'light' && view !== 'settings')
            if (view === 'light') {
              send(res, 200, { enabled: result.enabled, lastSyncAt: result.lastSyncAt, peers: result.peers })
            } else send(res, 200, result)
          } else if (req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json') {
            let command = await body(req)
            if (command && typeof command === 'object' && 'action' in command &&
                (command.action === 'set-sync-password' || command.action === 'join-with-password')) {
              if (!(req.socket instanceof TLSSocket) && !isLoopback(normalizeRemote(req.socket.remoteAddress))) {
                throw new PasswordPairingError('请从本机 DSH 或 HTTPS 页面输入同步密码。')
              }
              if ('password' in command || !('passwordBox' in command)) throw new PasswordPairingError('无法安全提交同步密码。')
              const { passwordBox, ...operation } = command
              command = { ...operation, password: await passwordInput.open(passwordBox) }
            }
            send(res, 200, await engine.command(command))
          } else send(res, 405, { error: { message: 'Method not allowed' } })
        } catch (error) {
          if (res.destroyed) return
          res.shouldKeepAlive = false
          const message = error instanceof PasswordPairingError ? error.message
            : error instanceof ZodError || error instanceof SyntaxError
              ? '共享设置请求无效，请检查输入。'
            : error instanceof Error && /^(Choose |Use |No eligible |Invalid Microsoft |OneDrive |Baidu Netdisk |Invalid WebDAV|Remove |Device |Confirm |Sharing |Backup |Unpaired |Revocation )/.test(error.message)
              ? error.message : '本次操作未能完成，已有聊天记录没有受到影响。你可以重试，或查看失败原因。'
          send(res, 400, { error: { message } })
        }
      },
    })
    return async () => {
      dispose()
      await engine.stop()
    }
  }, 'chatds-sharing.mount')
}
