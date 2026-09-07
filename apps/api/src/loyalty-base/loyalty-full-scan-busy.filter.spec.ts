import "reflect-metadata";
import type { ArgumentsHost } from "@nestjs/common";
import {
  LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS,
  LoyaltyFullScanBusyException,
} from "./loyalty-base.service";
import { LoyaltyFullScanBusyFilter } from "./loyalty-full-scan-busy.filter";

describe("LoyaltyFullScanBusyFilter", () => {
  it("returns a fail-loud 503 with an HTTP Retry-After header", () => {
    const response = {
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const exception = new LoyaltyFullScanBusyException();

    new LoyaltyFullScanBusyFilter().catch(exception, host);

    expect(response.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      String(LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS),
    );
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "LOYALTY_FULL_SCAN_BUSY",
        retryAfterSeconds: LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS,
      }),
    );
  });
});
