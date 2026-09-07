import { AmoCrmAdapter } from "@st-michael/integrations";

describe("AmoCrmAdapter broker company replacement", () => {
  it("links the current agency and removes obsolete company links", async () => {
    const adapter = new AmoCrmAdapter();
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        _embedded: {
          links: [
            { to_entity_id: 11, to_entity_type: "companies" },
            { to_entity_id: 12, to_entity_type: "companies" },
            { to_entity_id: 99, to_entity_type: "leads" },
          ],
        },
      })
      .mockResolvedValueOnce(undefined);
    (adapter as any).request = request;
    const link = jest
      .spyOn(adapter, "linkContactToCompany")
      .mockResolvedValue(undefined);

    await adapter.replaceContactCompany(101, 12);

    expect(link).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/contacts/101/unlink",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify([
          { to_entity_id: 11, to_entity_type: "companies" },
        ]),
      }),
    );
  });

  it("links a new agency before removing the previous company", async () => {
    const adapter = new AmoCrmAdapter();
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        _embedded: {
          links: [{ to_entity_id: 11, to_entity_type: "companies" }],
        },
      })
      .mockResolvedValueOnce(undefined);
    (adapter as any).request = request;
    const link = jest
      .spyOn(adapter, "linkContactToCompany")
      .mockResolvedValue(undefined);

    await adapter.replaceContactCompany(101, 12);

    expect(link).toHaveBeenCalledWith(101, 12);
    expect(link.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[1],
    );
  });
});
