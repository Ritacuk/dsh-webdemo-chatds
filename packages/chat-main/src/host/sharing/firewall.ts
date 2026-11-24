import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const programId = createHash('sha256').update(process.execPath.toLowerCase()).digest('hex').slice(0, 16)
const names = (owner: string) => {
  const prefix = 'ChatDS-Sync-' + programId + '-' + createHash('sha256').update(owner).digest('hex').slice(0, 16)
  return { tcp: quote(prefix + '-tcp'), mdns: quote(prefix + '-mdns') }
}

export interface FirewallStatus {
  supported: boolean
  elevated?: boolean
  profile?: string
  rulePresent?: boolean
  ruleOwned?: boolean
  hint?: string
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'"
}

async function powershell(script: string, timeout = 8_000): Promise<string> {
  const { stdout } = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout, windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

function ruleMatches(name: string, protocol: 'TCP' | 'UDP', port: number, multicast = false) {
  return [
    `$rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name ${name} -ErrorAction SilentlyContinue`,
    '$match = $false',
    "if ($rule -and $rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and $rule.Profile -eq 'Private') {",
    '$ports = $rule | Get-NetFirewallPortFilter',
    '$addresses = $rule | Get-NetFirewallAddressFilter',
    '$app = $rule | Get-NetFirewallApplicationFilter',
    `$match = ($ports.Protocol -eq '${protocol}' -and $ports.LocalPort -eq '${port}' -and @($ports.LocalPort).Count -eq 1 -and $addresses.RemoteAddress -eq 'LocalSubnet' -and @($addresses.RemoteAddress).Count -eq 1 -and $app.Program -eq ${quote(process.execPath)}${multicast ? " -and $addresses.LocalAddress -eq '224.0.0.251'" : ''})`,
    '}',
  ].join('\n')
}

export async function firewallStatus(owner: string, port?: number, address?: string): Promise<FirewallStatus> {
  if (process.platform !== 'win32') return { supported: false }
  const { tcp, mdns } = names(owner)
  const script = [
    '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    address ? `$alias = (Get-NetIPAddress -IPAddress ${quote(address)} -ErrorAction SilentlyContinue | Select-Object -First 1).InterfaceAlias` : '$alias = $null',
    'if ($alias) { $profile = (Get-NetConnectionProfile -InterfaceAlias $alias -ErrorAction SilentlyContinue).NetworkCategory } else { $profile = $null }',
    port ? ruleMatches(tcp, 'TCP', port) : '$match = $false',
    '$tcpOK = $match',
    ruleMatches(mdns, 'UDP', 5353, true),
    `$owned = @(Get-NetFirewallRule -Name @(${tcp},${mdns}) -ErrorAction SilentlyContinue).Count`,
    '[pscustomobject]@{ admin = $admin; profile = [string]$profile; matching = ($tcpOK -and $match); owned = $owned } | ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const value = JSON.parse(await powershell(script)) as { admin?: boolean; profile?: string; matching?: boolean; owned?: number }
    return { supported: true, elevated: value.admin === true, profile: value.profile || undefined, rulePresent: !!value.matching, ruleOwned: !!value.owned }
  } catch {
    return { supported: true, hint: '无法读取 Windows 防火墙状态。' }
  }
}

/** Mutations use a fixed, validated rule specification and Windows' normal UAC prompt. */
export async function changeFirewallRule(owner: string, action: 'apply' | 'remove', port?: number, address?: string) {
  if (process.platform !== 'win32') throw new Error('Windows firewall rules can only be changed on Windows')
  if (action === 'apply' && (!port || !Number.isInteger(port) || port > 65_535 || port < 1024)) {
    throw new Error('Enable LAN sync before adding a firewall rule')
  }
  const state = await firewallStatus(owner, port, address)
  if (action === 'apply' && state.rulePresent || action === 'remove' && state.ruleOwned === false) {
    return { ...state, applied: true }
  }
  const { tcp, mdns } = names(owner)
  const program = quote(process.execPath)
  const remove = `Get-NetFirewallRule -Name @(${tcp},${mdns}) -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop`
  const add = (name: string, label: string, protocol: string, localPort: number, local = '') =>
    `New-NetFirewallRule -Name ${name} -DisplayName '${label}' -Direction Inbound -Action Allow -Protocol ${protocol} -LocalPort ${localPort} ${local} -Profile Private -RemoteAddress LocalSubnet -Program ${program} -ErrorAction Stop | Out-Null`
  const script = action === 'apply'
    ? `${remove}; try { ${add(tcp, 'ChatDS LAN sync', 'TCP', port!)}; ${add(mdns, 'ChatDS LAN discovery', 'UDP', 5353, '-LocalAddress 224.0.0.251')} } catch { ${remove}; throw }`
    : remove
  const command = '$ErrorActionPreference = "Stop"; try { ' + script + '; exit 0 } catch { exit 1 }'
  try {
    if (state.elevated) await powershell(command)
    else {
      const encoded = Buffer.from(command, 'utf16le').toString('base64')
      await powershell(`$p = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode`, 60_000)
    }
    const actual = await firewallStatus(owner, port, address)
    const applied = action === 'apply' ? actual.rulePresent === true : actual.ruleOwned === false
    return { ...actual, applied, ...(applied ? {} : { error: 'Windows 未确认防火墙变更。请重新检测网络。' }) }
  } catch {
    return { ...state, applied: false, error: 'Windows 未完成防火墙变更。权限请求可能已取消，或此电脑由组织策略管理。' }
  }
}
