import { z } from 'zod'

const API_BASE_URL = process.env.API_URL || 'http://localhost:4000'

// Схемы для валидации ответов API
const BrokerSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string(),
  commissionLevel: z.string(),
  telegramChatId: z.string().optional(),
})

const LotSchema = z.object({
  id: z.string(),
  project: z.string(),
  rooms: z.number(),
  area: z.number(),
  price: z.number(),
  floor: z.number(),
  status: z.string(),
})

const DealSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.number(),
  commission: z.number(),
  createdAt: z.string(),
})

export class ApiService {
  private async request(endpoint: string, options?: RequestInit) {
    const url = `${API_BASE_URL}${endpoint}`
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    })

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`)
    }

    return response.json()
  }

  async getBrokerByTelegramId(telegramId: string) {
    const data = await this.request(`/brokers/telegram/${telegramId}`)
    return BrokerSchema.parse(data)
  }

  async getBrokerByPhone(phone: string) {
    const data = await this.request(`/brokers/phone/${phone}`)
    return BrokerSchema.parse(data)
  }

  async updateBrokerTelegramId(brokerId: string, telegramId: string) {
    const data = await this.request(`/brokers/${brokerId}/telegram`, {
      method: 'PATCH',
      body: JSON.stringify({ telegramChatId: telegramId }),
    })
    return BrokerSchema.parse(data)
  }

  async getLots(filters?: { project?: string; rooms?: number; maxPrice?: number }) {
    const params = new URLSearchParams()
    if (filters?.project) params.append('project', filters.project)
    if (filters?.rooms) params.append('rooms', filters.rooms.toString())
    if (filters?.maxPrice) params.append('maxPrice', filters.maxPrice.toString())

    const data = await this.request(`/lots?${params.toString()}`)
    return z.array(LotSchema).parse(data)
  }

  async getBrokerDeals(brokerId: string) {
    const data = await this.request(`/deals/broker/${brokerId}`)
    return z.array(DealSchema).parse(data)
  }

  async getBrokerCommission(brokerId: string) {
    const data = await this.request(`/commission/broker/${brokerId}`)
    return z.object({
      level: z.string(),
      rate: z.number(),
      earned: z.number(),
      nextLevel: z.string().optional(),
      progress: z.number().optional(),
    }).parse(data)
  }

  async createClientFixation(data: {
    brokerId: string
    firstName: string
    lastName: string
    phone: string
    agencyId: string
  }) {
    const response = await this.request('/client-fixation', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    return response
  }

  async sendSmsOtp(phone: string) {
    const response = await this.request('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    })
    return response
  }

  async verifySmsOtp(phone: string, code: string) {
    const response = await this.request('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    })
    return response
  }
}

export const apiService = new ApiService()