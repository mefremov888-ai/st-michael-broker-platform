import 'dotenv/config'
import { bot } from './src/bot'

async function main() {
  console.log('Starting ST Michael Telegram Bot...')

  // Запуск бота
  await bot.start()

  console.log('Bot is running!')
}

main().catch(console.error)