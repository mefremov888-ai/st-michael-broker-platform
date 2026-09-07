import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';

export type ImportJobStep =
  | 'queued'
  | 'parsing'
  | 'writing-brokers'
  | 'writing-call-logs'
  | 'writing-coords'
  | 'done'
  | 'failed';

export interface BrokerImportJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  step: ImportJobStep;
  startedAt: string;
  finishedAt?: string;
  progress: { current: number; total: number };
  result?: any;
  error?: string;
}

/**
 * Реестр фоновых задач импорта брокеров. В памяти (без БД) — джобы живут до
 * рестарта API-контейнера. Этого достаточно: импорт идёт минуты, не часы,
 * и при рестарте админ просто перезапускает заново.
 *
 * Очистка старых джоб — раз в час.
 */
@Injectable()
export class BrokerImportJobsService {
  private jobs = new Map<string, BrokerImportJob>();

  constructor() {
    // Старые завершённые джобы (старше часа) удаляем, чтобы не утекала память
    setInterval(() => this.cleanup(), 60 * 60 * 1000).unref();
  }

  create(): BrokerImportJob {
    const id = randomUUID();
    const job: BrokerImportJob = {
      id,
      status: 'queued',
      step: 'queued',
      startedAt: new Date().toISOString(),
      progress: { current: 0, total: 0 },
    };
    this.jobs.set(id, job);
    return job;
  }

  update(id: string, patch: Partial<BrokerImportJob>) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }

  setProgress(id: string, current: number, total: number, step?: ImportJobStep) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = { current, total };
    if (step) job.step = step;
  }

  finish(id: string, result: any) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.step = 'done';
    job.finishedAt = new Date().toISOString();
    job.result = result;
  }

  fail(id: string, error: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'failed';
    job.step = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error;
  }

  get(id: string): BrokerImportJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`Импорт-джоба ${id} не найдена (возможно прошёл час и она удалена, или сервер перезагружался)`);
    return job;
  }

  private cleanup() {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && new Date(job.finishedAt).getTime() < hourAgo) {
        this.jobs.delete(id);
      }
    }
  }
}
