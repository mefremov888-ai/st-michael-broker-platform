import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { OpsAlertService } from '../ops-alert/ops-alert.service';
import { FixationFailureInterceptor } from './fixation-failure.interceptor';

describe('FixationFailureInterceptor', () => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 'broker-1' }, route: { path: '/clients/fix' } }),
    }),
  } as unknown as ExecutionContext;

  it('alerts on an unexpected technical failure without request PII', async () => {
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new Error('database connection contains sensitive details');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);

    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const message = opsAlerts.sendSafely.mock.calls[0][0] as string;
    expect(message).toContain('brokerId: broker-1');
    expect(message).toContain('category: UNEXPECTED_ERROR');
    expect(message).not.toContain('sensitive details');
  });

  it('does not alert on an expected 4xx response', async () => {
    const opsAlerts = { sendSafely: jest.fn() };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new BadRequestException('invalid form');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });
});
