import { InlineKeyboard } from 'grammy'
import type { MyContext } from '../types/context'

export async function materialsCommand(ctx: MyContext) {
  const keyboard = new InlineKeyboard()
    .text('📖 Брошюра ЖК', 'material_brochure')
    .row()
    .text('🏠 Планировки', 'material_plans')
    .row()
    .text('💰 Прайс-лист', 'material_price')
    .row()
    .text('🎥 Видео', 'material_video')

  await ctx.reply(
    '📄 *Материалы для работы*\n\nВыберите нужный материал:',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  )
}
