// Types based on Prisma schema

import { UserRole, UserStatus, CommissionLevel, Project, UniquenessStatus, BrokerFunnelStage, BrokerSource, FixationStatus, ClientStatus, ContractType, DealStatus, LotStatus, CallDirection, CallStatus, CallResult, Sentiment, MeetingType, MeetingStatus, NotificationChannel, NotificationStatus } from './enums';

export interface Agency {
  id: string;
  name: string;
  legalName?: string;
  inn: string;
  phone?: string;
  email?: string;
  address?: string;
  totalSqmSold: number;
  commissionLevel: CommissionLevel;
  quarterlyBonusStreak: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Broker {
  id: string;
  amoContactId?: bigint;
  fullName: string;
  phone: string;
  email?: string;
  passwordHash?: string;
  role: UserRole;
  status: UserStatus;
  funnelStage: BrokerFunnelStage;
  source?: BrokerSource;
  closureReason?: string;
  telegramChatId?: bigint;
  brokerTourVisited: boolean;
  brokerTourDate?: Date;
  doNotCall: boolean;
  bestCallTime?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Client {
  id: string;
  brokerId: string;
  amoLeadId?: bigint;
  fullName: string;
  phone: string;
  email?: string;
  comment?: string;
  project: Project;
  fixationAgencyId?: string;
  uniquenessStatus: UniquenessStatus;
  uniquenessReason?: string;
  uniquenessExpiresAt?: Date;
  fixationStatus: FixationStatus;
  fixationExpiresAt?: Date;
  inspectionActSigned: boolean;
  status: ClientStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lot {
  id: string;
  externalId?: string;
  number: string;
  project: Project;
  building: string;
  floor: number;
  rooms: string;
  sqm: number;
  price: number;
  pricePerSqm?: number;
  status: LotStatus;
  layoutUrl?: string;
  planImageUrl?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Deal {
  id: string;
  clientId: string;
  brokerId: string;
  agencyId?: string;
  lotId?: string;
  amoDealId?: bigint;
  project: Project;
  contractType?: ContractType;
  amount: number;
  sqm: number;
  commissionRate: number;
  commissionAmount: number;
  paymentReceived: boolean;
  paymentPercent: number;
  isInstallment: boolean;
  status: DealStatus;
  signedAt?: Date;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Call {
  id: string;
  brokerId: string;
  mangoCallId?: string;
  direction: CallDirection;
  status: CallStatus;
  result?: CallResult;
  durationSec?: number;
  transcript?: string;
  sentiment?: Sentiment;
  recordingUrl?: string;
  attemptNumber: number;
  cycleDay: number;
  materialsSent?: any;
  createdAt: Date;
}

export interface Meeting {
  id: string;
  clientId: string;
  brokerId: string;
  managerId?: string;
  type: MeetingType;
  date: Date;
  comment?: string;
  status: MeetingStatus;
  actSigned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Document {
  id: string;
  name: string;
  type: string;
  category: string;
  project?: Project;
  fileUrl: string;
  fileSize?: number;
  createdAt: Date;
}

export interface Notification {
  id: string;
  brokerId: string;
  channel: NotificationChannel;
  subject?: string;
  body: string;
  status: NotificationStatus;
  sentAt?: Date;
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  payload?: any;
  ip?: string;
  createdAt: Date;
}

// Additional types for API
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}