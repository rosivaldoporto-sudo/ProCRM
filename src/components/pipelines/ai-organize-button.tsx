'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, Loader2 } from 'lucide-react'
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
  const canEdit = useCan('edit-settings')

  async function handleOrganize() {
    setLoading(true)
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

      const { recommendations, moved } = data as {
        recommendations: OrganizeResult[]
        moved: number
      }

      if (moved === 0) {
        const alreadyOk = recommendations.filter(
          (r: OrganizeResult) => r.from_stage === r.to_stage
        ).length
        if (alreadyOk > 0) {
          toast.info(
            `Todos os ${alreadyOk} cards já estão nas etapas corretas.`
          )
        } else {
          toast.info('Nenhum card para organizar.')
        }
      } else {
        toast.success(
          `${moved} card${moved > 1 ? 's' : ''} movido${moved > 1 ? 's' : ''} com sucesso!`
        )
        onOrganized?.()
      }
    } catch {
      toast.error('Erro de conexão ao organizar pipeline.')
    } finally {
      setLoading(false)
    }
  }

  return (
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
      {loading ? 'Organizando...' : 'Organizar com IA'}
    </Button>
  )
}
