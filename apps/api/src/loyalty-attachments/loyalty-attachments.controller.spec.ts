import { UserRole } from "@st-michael/shared";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { LoyaltyAttachmentsController } from "./loyalty-attachments.controller";
import {
  LoyaltyAttachmentEditGuard,
  LoyaltyAttachmentReadGuard,
} from "./loyalty-attachments.guard";

const user: any = {
  id: "manager-1",
  role: UserRole.MANAGER,
  phone: "",
  fullName: "Manager",
};

describe("LoyaltyAttachmentsController", () => {
  it("keeps the endpoint behind staff role guards", () => {
    expect(Reflect.getMetadata("roles", LoyaltyAttachmentsController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("binds grant guards to routes before upload/download handlers run", () => {
    const prototype = LoyaltyAttachmentsController.prototype;
    expect(Reflect.getMetadata(GUARDS_METADATA, prototype.upload)).toContain(
      LoyaltyAttachmentEditGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, prototype.download)).toContain(
      LoyaltyAttachmentReadGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, prototype.archive)).toContain(
      LoyaltyAttachmentEditGuard,
    );
  });

  it("downloads as a no-store attachment with an RFC 5987-safe filename", async () => {
    const data = Buffer.from("%PDF-1");
    const service: any = {
      download: jest.fn().mockResolvedValue({
        id: "attachment-1",
        fileName: "résumé's(1).pdf",
        mimeType: "application/pdf",
        size: data.length,
        data,
      }),
    };
    const response: any = { set: jest.fn() };
    const controller = new LoyaltyAttachmentsController(service);

    const stream = await controller.download(
      "33333333-3333-4333-8333-333333333333",
      user,
      response,
    );

    expect(service.download).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      user,
    );
    expect(response.set).toHaveBeenCalledWith({
      "Content-Disposition":
        "attachment; filename=\"loyalty-attachment\"; filename*=UTF-8''r%C3%A9sum%C3%A9%27s%281%29.pdf",
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream.getStream())
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(data);
  });
});
