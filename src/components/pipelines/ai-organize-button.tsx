'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Sparkles, Loader2, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useCan } from '@/hooks/use-can'

interface OrganizeResult {
  deal_id: string
  title: string
  from_stage: string
  to_stage: string
  reason: string
  moved: boolean
}

interface AiOrganizeButtonProps {
  pipelineId: string
  onOrganized?: () => void
}

export function AiOrganizeButton({ pipelineId, onOrganized }: AiOrganizeButtonProps) {
  const [loading, setLoading] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [results, setResults] = useState<OrganizeResult[]>([])
  const [movedCount, setMovedCount] = useState(0)
  const canEdit = useCan('edit-settings')

  async function handleOrganize() {
    setLoading(true)
    toast.info('Analisando conversas dos cards...')
    try {
      const res = await fetch('/api/ai/organize-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_id: pipelineId }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Erro ao organizar pipeline')
        return
      }

      const recs = (data.recommendations ?? []) as OrganizeResult[]
      const moved = (data.moved ?? 0) as number

      setResults(recs)
      setMovedCount(moved)
      setResultsOpen(true)

      if (moved > 0) {
        onOrganized?.()
      }
    } catch {
      toast.error('Erro de conexão ao organizar pipeline.')
    } finally {
      setLoading(false)
    }
  }

  const movedItems = results.filter((r) => r.moved)
  const okItems = results.filter((r) => !r.moved && r.from_stage === r.to_stage)
  const errorItems = results.filter(
    (r) => !r.moved && r.from_stage === r.to_stage && r.reason.includes('Erro')
  )

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || !canEdit}
        onClick={handleOrganize}
        className="border-border bg-card text-foreground hover:bg-muted"
        title={
          !canEdit
            ? 'Read-only — your role can\'t organize pipeline'
            : 'Organizar pipeline com IA'
        }
      >
        {loading ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="mr-1 h-4 w-4" />
        )}
        {loading ? 'Analisando cards...' : 'Organizar com IA'}
      </Button>

      <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Resultado da Organização
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-3">
            {movedItems.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {movedItems.length} card{movedItems.length > 1 ? 's' : ''} movido{movedItems.length > 1 ? 's' : ''}
                </p>
                {movedItems.map((r) => (
                  <div
                    key={r.deal_id}
                    className="rounded-lg border border-green-500/20 bg-green-500/5 p-3 space-y-1"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                      <span className="font-medium text-foreground truncate">{r.title}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground ml-6">
                      <span>{r.from_stage}</span>
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      <span className="font-medium text-foreground">{r.to_stage}</span>
                    </div>
                    {r.reason && (
                      <p className="text-xs text-muted-foreground ml-6">{r.reason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {okItems.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {okItems.length} card{okItems.length > 1 ? 's' : ''} já na etapa correta
                </p>
                {okItems.map((r) => (
                  <div
                    key={r.deal_id}
                    className="rounded-lg border border-border p-3 space-y-1"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-foreground truncate">{r.title}</span>
                      <span className="text-muted-foreground">— {r.from_stage}</span>
                    </div>
                    {r.reason && (
                      <p className="text-xs text-muted-foreground ml-6">{r.reason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {errorItems.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {errorItems.length} erro{errorItems.length > 1 ? 's' : ''}
                </p>
                {errorItems.map((r) => (
                  <div
                    key={r.deal_id}
                    className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 space-y-1"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                      <span className="text-foreground truncate">{r.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground ml-6">{r.reason}</p>
                  </div>
                ))}
              </div>
            )}

            {results.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Nenhum card aberto com conversa encontrado neste pipeline.
              </p>
            )}
          </div>

          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setResultsOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
