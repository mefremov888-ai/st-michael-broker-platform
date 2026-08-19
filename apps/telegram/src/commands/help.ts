import { mainKeyboard } from '../keyboards/main'
import type { MyContext } from '../types/context'

export async function helpCommand(ctx: MyContext) {
  const message = `❓ *Помощь по боту*\n\n` +
    `*Команды:*\n` +
    `/start — авторизация по номеру телефона\n` +
    `/commission — информация о вашей комиссии\n` +
    `/deals — статус ваших сделок\n` +
    `/materials — материалы для работы\n` +
    `/help — эта справка\n\n` +
    `*Клавиатура:*\n` +
    `📊 Моя комиссия — текущая ставка и заработок\n` +
    `🏠 Каталог ЖК — просмотр доступных объектов\n` +
    `📋 Мои сделки — активные сделки\n` +
    `📄 Материалы — брошюры и презентации\n\n` +
    `Для вопросов обращайтесь к менеджеру: @manager`

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: mainKeyboard
  })
}
