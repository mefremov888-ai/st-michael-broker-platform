/**
 * Public Call projection. `mangoEventSeq` is deliberately absent: it is an
 * internal BigInt ordering guard and native JSON serialization rejects BigInt.
 */
export const PUBLIC_CALL_SELECT = {
  id: true,
  brokerId: true,
  clientId: true,
  mangoCallId: true,
  direction: true,
  status: true,
  result: true,
  durationSec: true,
  transcript: true,
  sentiment: true,
  recordingUrl: true,
  attemptNumber: true,
  cycleDay: true,
  materialsSent: true,
  initiatedAt: true,
  createdAt: true,
} as const;

/** Defense in depth for mocked/custom Prisma clients that do not honor select. */
export function toPublicCall<T extends Record<string, unknown>>(
  call: T,
): Omit<T, 'mangoEventSeq'> {
  const { mangoEventSeq: _internalSeq, ...publicCall } = call;
  return publicCall as Omit<T, 'mangoEventSeq'>;
}
