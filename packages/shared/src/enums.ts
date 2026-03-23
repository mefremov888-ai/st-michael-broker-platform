// Enums from Prisma schema

export enum UserRole {
  BROKER = 'BROKER',
  MANAGER = 'MANAGER',
  ADMIN = 'ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
  PENDING = 'PENDING',
}

export enum CommissionLevel {
  START = 'START',
  BASIC = 'BASIC',
  STRONG = 'STRONG',
  PREMIUM = 'PREMIUM',
  ELITE = 'ELITE',
  CHAMPION = 'CHAMPION',
  LEGEND = 'LEGEND',
}

export enum Project {
  ZORGE9 = 'ZORGE9',
  SILVER_BOR = 'SILVER_BOR',
}

export enum UniquenessStatus {
  CONDITIONALLY_UNIQUE = 'CONDITIONALLY_UNIQUE',
  REJECTED = 'REJECTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  EXPIRED = 'EXPIRED',
}

export enum BrokerFunnelStage {
  NEW_BROKER = 'NEW_BROKER',
  BROKER_TOUR = 'BROKER_TOUR',
  FIXATION = 'FIXATION',
  MEETING = 'MEETING',
  DEAL = 'DEAL',
}

export enum BrokerSource {
  CRM_MANUAL = 'CRM_MANUAL',
  BROKER_CABINET = 'BROKER_CABINET',
  PHONE_CALL = 'PHONE_CALL',
  CLOSED_AS_BROKER = 'CLOSED_AS_BROKER',
}

export enum FixationStatus {
  NOT_FIXED = 'NOT_FIXED',
  FIXED = 'FIXED',
  EXPIRED = 'EXPIRED',
  ANNULLED = 'ANNULLED',
}

export enum ClientStatus {
  NEW = 'NEW',
  BOOKED = 'BOOKED',
  DEAL = 'DEAL',
  CANCELLED = 'CANCELLED',
}

export enum ContractType {
  DDU = 'DDU',
  DKP = 'DKP',
  PDKP = 'PDKP',
}

export enum DealStatus {
  PENDING = 'PENDING',
  SIGNED = 'SIGNED',
  PAID = 'PAID',
  COMMISSION_PAID = 'COMMISSION_PAID',
  CANCELLED = 'CANCELLED',
}

export enum LotStatus {
  AVAILABLE = 'AVAILABLE',
  BOOKED = 'BOOKED',
  SOLD = 'SOLD',
}

export enum CallDirection {
  OUTBOUND = 'OUTBOUND',
  INBOUND = 'INBOUND',
}

export enum CallStatus {
  COMPLETED = 'COMPLETED',
  NO_ANSWER = 'NO_ANSWER',
  BUSY = 'BUSY',
  UNAVAILABLE = 'UNAVAILABLE',
  FAILED = 'FAILED',
}

export enum CallResult {
  INTERESTED = 'INTERESTED',
  NOT_INTERESTED = 'NOT_INTERESTED',
  CALLBACK = 'CALLBACK',
  MEETING_SCHEDULED = 'MEETING_SCHEDULED',
}

export enum Sentiment {
  POSITIVE = 'POSITIVE',
  NEUTRAL = 'NEUTRAL',
  NEGATIVE = 'NEGATIVE',
}

export enum MeetingType {
  OFFICE_VISIT = 'OFFICE_VISIT',
  ONLINE = 'ONLINE',
  BROKER_TOUR = 'BROKER_TOUR',
}

export enum MeetingStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum NotificationChannel {
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
  TELEGRAM = 'TELEGRAM',
  EMAIL = 'EMAIL',
}

export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}