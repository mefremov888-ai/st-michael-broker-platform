import { Bot, session } from 'grammy'
import { conversations, createConversation } from '@grammyjs/conversations'
import { apiService } from './services/api'
import { authMiddleware } from './middleware/auth'
import { loggingMiddleware } from './middleware/logging'

// Импорт команд
import { startCommand } from './commands/start'
import { commissionCommand } from './commands/commission'
import { dealsCommand } from './commands/deals'
import { materialsCommand } from './commands/materials'
import { helpCommand } from './commands/help'

// Импорт conversations
import { fixClientConversation } from './conversations/fixClient'
import { selectLotConversation } from './conversations/selectLot'
import { calculatorConversation } from './conversations/calculator'

// Импорт клавиатур
import { mainKeyboard } from './keyboards/main'
import type { MyContext, SessionData } from './types/context'

const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!)

bot.use(session<SessionData, MyContext>({ initial: () => ({}) }))
bot.use(conversations<MyContext>())

// Middleware
bot.use(loggingMiddleware)
bot.use(authMiddleware)

// Команды
bot.command('start', startCommand)
bot.command('commission', commissionCommand)
bot.command('deals', dealsCommand)
bot.command('materials', materialsCommand)
bot.command('help', helpCommand)

// Conversations
bot.use(createConversation(fixClientConversation))
bot.use(createConversation(selectLotConversation))
bot.use(createConversation(calculatorConversation))

// Обработчики клавиатуры
bot.callbackQuery('fix_client', async (ctx) => {
  await ctx.conversation.enter('fixClient')
  await ctx.answerCallbackQuery()
})

bot.callbackQuery('select_lot', async (ctx) => {
  await ctx.conversation.enter('selectLot')
  await ctx.answerCallbackQuery()
})

bot.callbackQuery('calculator', async (ctx) => {
  await ctx.conversation.enter('calculator')
  await ctx.answerCallbackQuery()
})

bot.callbackQuery('commission_calc', async (ctx) => {
  await ctx.conversation.enter('commissionCalc')
  await ctx.answerCallbackQuery()
})

// Обработчик текстовых сообщений
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text

  if (text === '📊 Моя комиссия') {
    await commissionCommand(ctx)
  } else if (text === '🏠 Каталог ЖК') {
    // Показать каталог
    await ctx.reply('Выберите жилой комплекс:', {
      reply_markup: mainKeyboard
    })
  } else if (text === '📋 Мои сделки') {
    await dealsCommand(ctx)
  } else if (text === '📄 Материалы') {
    await materialsCommand(ctx)
  } else if (text === '❓ Помощь') {
    await helpCommand(ctx)
  } else {
    await ctx.reply('Используйте команды или клавиатуру для навигации', {
      reply_markup: mainKeyboard
    })
  }
})

export { bot }
