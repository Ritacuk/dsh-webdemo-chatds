import type { Context } from '@deepseek-ai/cordis'

/** The CLI and Desktop do not always populate the same process variables. */
export function currentProfile(ctx: Context): string {
  const profile = ctx.get('profileContext' as never) as { name?: string } | undefined
  return profile?.name || process.env['DSH_PROFILE'] || 'default'
}
