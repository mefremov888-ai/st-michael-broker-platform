import { apiService } from '../services/api'
import type { MyContext } from '../types/context'

export async function dealsCommand(ctx: MyContext) {
  const broker = ctx.session?.broker

  if (!broker) {
    await ctx.reply('Вы не авторизованы')
    return
  }

  try {
    const deals = await apiService.getBrokerDeals(broker.id)

    if (deals.length === 0) {
      await ctx.reply('У вас пока нет сделок')
      return
    }

    let message = `📋 *Ваши сделки*\n\n`

    deals.forEach((deal, index) => {
      const statusEmoji = {
        'pending': '⏳',
        'signed': '✍️',
        'paid': '💰',
        'cancelled': '❌'
      }[deal.status] || '❓'

      message += `${index + 1}. ${statusEmoji} Сделка #${deal.id}\n`
      message += `   Сумма: ₽${deal.amount.toLocaleString()}\n`
      message += `   Комиссия: ₽${deal.commission.toLocaleString()}\n`
      message += `   Дата: ${new Date(deal.createdAt).toLocaleDateString('ru-RU')}\n\n`
    })

    await ctx.reply(message, { parse_mode: 'Markdown' })
  } catch (error) {
    console.error('Deals command error:', error)
    await ctx.reply('Ошибка получения данных о сделках')
  }
}
