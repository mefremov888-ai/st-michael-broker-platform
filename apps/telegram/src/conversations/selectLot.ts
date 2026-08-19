import { apiService } from '../services/api'
import { InlineKeyboard } from 'grammy'
import type { MyContext, MyConversation } from '../types/context'

export async function selectLotConversation(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply('🏠 *Подбор квартиры*\n\nВыберите проект:', {
    parse_mode: 'Markdown',
    reply_markup: new InlineKeyboard()
      .text('Зорге 9', 'project_zorge9')
      .text('Серебряный Бор', 'project_silverbor')
  })

  const projectCtx = await conversation.waitFor('callback_query')
  await projectCtx.answerCallbackQuery()

  const project = projectCtx.callbackQuery.data === 'project_zorge9' ? 'ZORGE9' : 'SILVER_BOR'

  await ctx.reply('🛏️ Сколько комнат? (1-3 или студия):')

  const roomsCtx = await conversation.waitFor('message:text')
  const roomsInput = roomsCtx.message.text.trim().toLowerCase()

  let rooms: number | undefined
  if (roomsInput === 'студия' || roomsInput === 'studio') {
    rooms = 0
  } else {
    rooms = parseInt(roomsInput)
    if (isNaN(rooms) || rooms < 1 || rooms > 3) {
      await ctx.reply('Введите корректное количество комнат (1-3) или "студия"')
      return
    }
  }

  await ctx.reply('💰 Максимальный бюджет (рублей):')

  const budgetCtx = await conversation.waitFor('message:text')
  const maxPrice = parseInt(budgetCtx.message.text.trim().replace(/\s/g, ''))

  if (isNaN(maxPrice) || maxPrice < 1000000) {
    await ctx.reply('Введите корректную сумму (минимум 1 млн рублей)')
    return
  }

  try {
    const lots = await apiService.getLots({
      project,
      rooms,
      maxPrice
    })

    if (lots.length === 0) {
      await ctx.reply('По заданным критериям ничего не найдено. Попробуйте изменить параметры.')
      return
    }

    let message = `🏠 *Найдено ${lots.length} вариантов*\n\n`

    lots.slice(0, 5).forEach((lot, index) => {
      message += `${index + 1}. ${lot.rooms === 0 ? 'Студия' : `${lot.rooms}-к`} ${lot.area}м²\n`
      message += `   Этаж ${lot.floor}, ₽${lot.price.toLocaleString()}\n\n`
    })

    if (lots.length > 5) {
      message += `... и ещё ${lots.length - 5} вариантов`
    }

    await ctx.reply(message, { parse_mode: 'Markdown' })
  } catch (error) {
    console.error('Select lot error:', error)
    await ctx.reply('Ошибка поиска. Попробуйте позже.')
  }
}
