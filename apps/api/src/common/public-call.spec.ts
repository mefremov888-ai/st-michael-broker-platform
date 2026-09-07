import { PUBLIC_CALL_SELECT, toPublicCall } from './public-call';

describe('public Call projection', () => {
  it('omits the internal BigInt seq and remains JSON serializable', () => {
    expect(PUBLIC_CALL_SELECT).not.toHaveProperty('mangoEventSeq');
    const payload = {
      calls: [
        toPublicCall({
          id: 'call-1',
          status: 'COMPLETED',
          mangoEventSeq: 42n,
        }),
      ],
    };

    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      calls: [{ id: 'call-1', status: 'COMPLETED' }],
    });
  });
});
