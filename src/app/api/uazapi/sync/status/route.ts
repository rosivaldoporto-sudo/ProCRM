import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'Informe o ID do job' }, { status: 400 });
    }

    const { data: job, error } = await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[uazapi-sync-status] fetch error:', error);
      return NextResponse.json({ error: 'Falha ao consultar o job' }, { status: 500 });
    }

    if (!job) {
      return NextResponse.json({ error: 'Job não encontrado' }, { status: 404 });
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
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 });
  }
}