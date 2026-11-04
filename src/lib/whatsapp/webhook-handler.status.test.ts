import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recipientUpdates: [] as Record<string, unknown>[],
  recipient: { id: 'r1', status: 'sent' } as Record<string, unknown> | null,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      let isUpdate = false;
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        update(values: Record<string, unknown>) {
          isUpdate = true;
          if (table === 'broadcast_recipients') mocks.recipientUpdates.push(values);
          return builder;
        },
        maybeSingle: async () => ({
          data: table === 'broadcast_recipients' ? mocks.recipient : null,
          error: null,
        }),
        then(resolve: (result: unknown) => void) {
          resolve({ data: null, error: null, isUpdate });
        },
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));

import { handleStatusUpdate } from './webhook-handler';

function statusOf(status: string, errors?: { code: number; title: string; details?: string }[]) {
  return {
    id: 'wamid-1',
    status,
    timestamp: '1760000000',
    recipient_id: '5511900000001',
    ...(errors ? { errors } : {}),
  };
}

describe('handleStatusUpdate — broadcast failure reason', () => {
  beforeEach(() => {
    mocks.recipientUpdates.length = 0;
    mocks.recipient = { id: 'r1', status: 'sent' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('saves the reason Meta gives for a failed delivery', async () => {
    await handleStatusUpdate(
      statusOf('failed', [
        { code: 131026, title: 'Message undeliverable', details: 'Not on WhatsApp' },
      ]),
    );

    expect(mocks.recipientUpdates).toEqual([
      {
        status: 'failed',
        error_message: '(#131026) Message undeliverable — Not on WhatsApp',
      },
    ]);
  });

  it('joins several reasons and accepts an error without details', async () => {
    await handleStatusUpdate(
      statusOf('failed', [
        { code: 131000, title: 'Something went wrong' },
        { code: 131049, title: 'Not delivered', details: 'Marketing limit' },
      ]),
    );

    expect(mocks.recipientUpdates[0].error_message).toBe(
      '(#131000) Something went wrong; (#131049) Not delivered — Marketing limit',
    );
  });

  it('marks the failure even when Meta sends no reason', async () => {
    await handleStatusUpdate(statusOf('failed'));

    expect(mocks.recipientUpdates).toEqual([{ status: 'failed' }]);
  });

  it('writes no error on a successful status', async () => {
    await handleStatusUpdate(statusOf('delivered'));

    expect(mocks.recipientUpdates).toHaveLength(1);
    expect(mocks.recipientUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(mocks.recipientUpdates[0]).not.toHaveProperty('error_message');
  });

  it('leaves a recipient alone once it was delivered', async () => {
    mocks.recipient = { id: 'r1', status: 'delivered' };

    await handleStatusUpdate(
      statusOf('failed', [{ code: 131026, title: 'Message undeliverable' }]),
    );

    expect(mocks.recipientUpdates).toEqual([]);
  });
});
