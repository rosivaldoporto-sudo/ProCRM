import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
    }

    const { data: job, error } = await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[uazapi-sync-status] fetch error:', error);
      return NextResponse.json({ error: 'Failed to fetch job status' }, { status: 500 });
    }

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
      totalChats: job.total_chats,
      syncedChats: job.synced_chats,
      importedMessages: job.imported_messages,
      currentChat: job.current_chat,
      errorMessage: job.error_message,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      progress: job.total_chats > 0 ? Math.round((job.synced_chats / job.total_chats) * 100) : 0,
    });
  } catch (error) {
    console.error('[uazapi-sync-status] error:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}