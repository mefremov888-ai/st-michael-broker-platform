import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { OpsAlertService } from '../ops-alert/ops-alert.service';

@Injectable()
export class FixationFailureInterceptor implements NestInterceptor {
  constructor(private readonly opsAlerts: OpsAlertService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;

        // Validation, auth and uniqueness conflicts are expected business
        // responses. Alert only when the fixation path failed technically.
        if (status >= 500) {
          const request = context.switchToHttp().getRequest<{
            user?: { id?: string };
            route?: { path?: string };
          }>();
          const brokerId = request?.user?.id || 'public/unknown';
          const route = request?.route?.path || 'fixation';
          const category = this.classify(error, status);

          void this.opsAlerts.sendSafely(
            [
              '🔴 PROD: техническая ошибка фиксации',
              `route: ${route}`,
              `brokerId: ${brokerId}`,
              `httpStatus: ${status}`,
              `category: ${category}`,
              `at: ${new Date().toISOString()}`,
              'Проверить API и /admin/broker-applications.',
            ].join('\n'),
            {
              dedupKey: `fixation-api:${category}`,
              cooldownMs: 5 * 60_000,
            },
          );
        }

        return throwError(() => error);
      }),
    );
  }

  private classify(error: unknown, status: number): string {
    const name = error instanceof Error ? error.name : '';
    if (name.startsWith('Prisma')) return 'DATABASE_ERROR';
    if (name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT';
    if (status === 502 || status === 503 || status === 504) return 'DEPENDENCY_UNAVAILABLE';
    return 'UNEXPECTED_ERROR';
  }
}
