-- ============================================================
-- 060 — Um agendamento ativo por horário e formulário
-- ============================================================
-- A validação no servidor evita oferecer horários ocupados, mas duas
-- confirmações simultâneas podiam passar pela checagem antes do INSERT.
-- O índice único parcial fecha essa corrida.
--
-- Antes de criar o índice, eventuais duplicatas históricas são canceladas
-- (mantém a mais antiga de cada form_id + starts_at).

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY form_id, starts_at
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM lead_form_bookings
  WHERE status = 'scheduled'
)
UPDATE lead_form_bookings AS b
SET status = 'cancelled'
FROM ranked AS r
WHERE b.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_form_bookings_unique_slot
  ON lead_form_bookings (form_id, starts_at)
  WHERE status = 'scheduled';
