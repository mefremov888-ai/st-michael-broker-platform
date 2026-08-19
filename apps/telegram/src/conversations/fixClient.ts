import { apiService } from '../services/api'
import type { MyContext, MyConversation } from '../types/context'

export async function fixClientConversation(conversation: MyConversation, ctx: MyContext) {
  const broker = ctx.session?.broker

  if (!broker) {
    await ctx.reply('Вы не авторизованы')
    return
  }

  await ctx.reply('🔒 *Фиксация клиента*\n\nВведите ФИО клиента:', { parse_mode: 'Markdown' })

  const fullNameCtx = await conversation.waitFor('message:text')
  const fullName = fullNameCtx.message.text.trim()

  if (fullName.length < 2) {
    await ctx.reply('ФИО должно содержать минимум 2 символа')
    return
  }

  const [firstName, ...lastNameParts] = fullName.split(' ')
  const lastName = lastNameParts.join(' ')

  await ctx.reply('📱 Введите номер телефона клиента (+7XXXXXXXXXX):')

  const phoneCtx = await conversation.waitFor('message:text')
  const phone = phoneCtx.message.text.trim()

  const phoneRegex = /^\+7\d{10}$/
  if (!phoneRegex.test(phone)) {
    await ctx.reply('Неверный формат номера. Используйте формат +7XXXXXXXXXX')
    return
  }

  // Получаем доступные агентства брокера
  // В реальности нужно получить из API
  const agencies = [
    { id: '1', name: 'Недвижимость+' },
    { id: '2', name: 'Тренд' },
    { id: '3', name: 'Ромашка' }
  ]

  let agencyMessage = '🏢 Выберите агентство для фиксации:\n\n'
  agencies.forEach((agency, index) => {
    agencyMessage += `${index + 1}. ${agency.name}\n`
  })
  agencyMessage += '\nВведите номер агентства:'

  await ctx.reply(agencyMessage)

  const agencyCtx = await conversation.waitFor('message:text')
  const agencyIndex = parseInt(agencyCtx.message.text.trim()) - 1

  if (isNaN(agencyIndex) || agencyIndex < 0 || agencyIndex >= agencies.length) {
    await ctx.reply('Неверный номер агентства')
    return
  }

  const selectedAgency = agencies[agencyIndex]

  try {
    await apiService.createClientFixation({
      brokerId: broker.id,
      firstName,
      lastName: lastName || '',
      phone,
      agencyId: selectedAgency.id
    })

    await ctx.reply(
      `✅ *Клиент зафиксирован!*\n\n` +
      `ФИО: ${fullName}\n` +
      `Телефон: ${phone}\n` +
      `Агентство: ${selectedAgency.name}\n\n` +
      `Менеджер получит уведомление для проверки.`,
      { parse_mode: 'Markdown' }
    )
  } catch (error) {
    console.error('Fix client error:', error)
    await ctx.reply('Ошибка фиксации клиента. Попробуйте позже.')
  }
}
