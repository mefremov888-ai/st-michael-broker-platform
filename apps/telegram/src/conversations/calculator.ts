import type { MyContext, MyConversation } from '../types/context'

export async function calculatorConversation(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply('🏦 *Ипотечный калькулятор*\n\nВведите стоимость квартиры (рублей):', { parse_mode: 'Markdown' })

  const priceCtx = await conversation.waitFor('message:text')
  const price = parseInt(priceCtx.message.text.trim().replace(/\s/g, ''))

  if (isNaN(price) || price < 1000000) {
    await ctx.reply('Введите корректную стоимость (минимум 1 млн рублей)')
    return
  }

  await ctx.reply('💰 Первоначальный взнос (рублей или процент):')

  const downPaymentCtx = await conversation.waitFor('message:text')
  const downPaymentInput = downPaymentCtx.message.text.trim().replace(/\s/g, '')

  let downPayment: number
  if (downPaymentInput.includes('%')) {
    const percent = parseFloat(downPaymentInput.replace('%', ''))
    if (isNaN(percent) || percent < 10 || percent > 90) {
      await ctx.reply('Процент взноса должен быть от 10% до 90%')
      return
    }
    downPayment = (price * percent) / 100
  } else {
    downPayment = parseInt(downPaymentInput)
    if (isNaN(downPayment) || downPayment < price * 0.1) {
      await ctx.reply('Взнос должен быть минимум 10% от стоимости')
      return
    }
  }

  await ctx.reply('📅 Срок ипотеки (лет, 5-30):')

  const termCtx = await conversation.waitFor('message:text')
  const termYears = parseInt(termCtx.message.text.trim())

  if (isNaN(termYears) || termYears < 5 || termYears > 30) {
    await ctx.reply('Срок должен быть от 5 до 30 лет')
    return
  }

  await ctx.reply('📊 Ставка (% годовых, например 12.5):')

  const rateCtx = await conversation.waitFor('message:text')
  const rate = parseFloat(rateCtx.message.text.trim().replace(',', '.'))

  if (isNaN(rate) || rate < 1 || rate > 25) {
    await ctx.reply('Ставка должна быть от 1% до 25%')
    return
  }

  // Расчет ипотеки
  const loanAmount = price - downPayment
  const monthlyRate = rate / 100 / 12
  const termMonths = termYears * 12

  const monthlyPayment = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
                         (Math.pow(1 + monthlyRate, termMonths) - 1)

  const totalPayment = monthlyPayment * termMonths
  const overpayment = totalPayment - loanAmount

  const message = `🏦 *Результат расчета*\n\n` +
    `💵 Стоимость квартиры: ₽${price.toLocaleString()}\n` +
    `💰 Первоначальный взнос: ₽${downPayment.toLocaleString()}\n` +
    `🏠 Сумма кредита: ₽${loanAmount.toLocaleString()}\n` +
    `📅 Срок: ${termYears} лет (${termMonths} месяцев)\n` +
    `📊 Ставка: ${rate}%\n\n` +
    `💳 *Ежемесячный платеж:*\n` +
    `₽${Math.round(monthlyPayment).toLocaleString()}\n\n` +
    `📈 *Общая переплата:*\n` +
    `₽${Math.round(overpayment).toLocaleString()}\n\n` +
    `💰 *Всего выплат:*\n` +
    `₽${Math.round(totalPayment).toLocaleString()}`

  await ctx.reply(message, { parse_mode: 'Markdown' })
}
