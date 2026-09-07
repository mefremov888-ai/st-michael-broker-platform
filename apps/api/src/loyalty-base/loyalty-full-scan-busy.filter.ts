import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { LoyaltyFullScanBusyException } from "./loyalty-full-scan-coordinator";

@Catch(LoyaltyFullScanBusyException)
export class LoyaltyFullScanBusyFilter implements ExceptionFilter {
  catch(exception: LoyaltyFullScanBusyException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader("Retry-After", String(exception.retryAfterSeconds));
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
