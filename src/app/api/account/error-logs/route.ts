import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const requested = Number(new URL(request.url).searchParams.get('limit'));
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 100)
      : 50;

    const { data, error } = await supabaseAdmin()
      .from('application_error_logs')
      .select(
        'id, request_id, occurred_at, source, route, method, error_name, message, context'
      )
      .eq('account_id', accountId)
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { error: 'Failed to load error logs' },
        { status: 500 }
      );
    }
    return NextResponse.json({ logs: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

