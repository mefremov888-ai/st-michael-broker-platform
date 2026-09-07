import { InlineKeyboard } from 'grammy'

export const mainKeyboard = new InlineKeyboard()
  .text('📊 Моя комиссия', 'commission')
  .row()
  .text('🏠 Каталог ЖК', 'catalog')
  .row()
  .text('📋 Мои сделки', 'deals')
  .row()
  .text('📄 Материалы', 'materials')
  .row()
  .text('❓ Помощь', 'help')