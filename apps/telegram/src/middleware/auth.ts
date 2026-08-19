import { apiService } from '../services/api'
import type { MyContext } from '../types/context'

export async function authMiddleware(ctx: MyContext, next: () => Promise<void>) {
  // Пропускаем команды start и help для неавторизованных пользователей
  if (ctx.message?.text === '/start' || ctx.message?.text === '/help') {
    return next()
  }

  // Проверяем авторизацию по telegramChatId
  if (!ctx.from?.id) {
    await ctx.reply('Ошибка авторизации')
    return
  }

  try {
    const broker = await apiService.getBrokerByTelegramId(ctx.from.id.toString())
    if (!broker) {
      await ctx.reply('Вы не авторизованы. Используйте /start для авторизации')
      return
    }

    // Сохраняем брокера в контексте
    ctx.session = { ...ctx.session, broker }
    await next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    await ctx.reply('Ошибка авторизации')
  }
}
