import type { MyContext } from '../types/context'

export async function loggingMiddleware(ctx: MyContext, next: () => Promise<void>) {
  const start = Date.now()
  const user = ctx.from?.username || ctx.from?.first_name || 'unknown'
  const command = ctx.message?.text || ctx.callbackQuery?.data || 'unknown'

  console.log(`[${new Date().toISOString()}] User: ${user}, Command: ${command}`)

  await next()

  const duration = Date.now() - start
  console.log(`[${new Date().toISOString()}] Completed in ${duration}ms`)
}
