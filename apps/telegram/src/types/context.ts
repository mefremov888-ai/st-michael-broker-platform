import type { Conversation, ConversationFlavor } from '@grammyjs/conversations'
import type { Context, SessionFlavor } from 'grammy'

export interface SessionBroker {
  id: string
  firstName: string
  lastName: string
  phone: string
  commissionLevel: string
  telegramChatId?: string
}

export interface SessionData {
  broker?: SessionBroker
}

/** Shared grammY context for the bot, middleware, commands, and conversations. */
export type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor
export type MyConversation = Conversation<MyContext>
