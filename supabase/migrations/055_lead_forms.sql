-- ============================================================
-- Lead Forms (Typebot-style): formulários conversacionais públicos
-- com qualificação, agendamento e eventos Meta Ads.
--
-- 1. lead_forms — envelope (nome, slug público, status, tema,
--    qualificação, agenda, meta, contadores).
-- 2. lead_form_blocks — blocos ordenados (perguntas). block_key é
--    string estável (clone sem reescrever referências).
-- 3. lead_form_responses — respostas por visitante (answers JSONB,
--    score, is_qualified, tracking UTM + fbp/fbc).
-- 4. lead_form_bookings — agendamentos para qualificados.
-- ============================================================

-- ---------- 1. lead_forms ----------
CREATE TABLE IF NOT EXISTS lead_forms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  theme_config JSONB NOT NULL DEFAULT '{"primary_color":"#7c3aed","background":"#0f0f14","font":"Inter","avatar_url":null,"logo_url":null,"welcome_title":"Vamos conversar?","welcome_subtitle":"Responda em menos de 1 minuto.","button_text":"Começar","show_branding":true,"bubble_user":"#7c3aed","bubble_bot":"#1f1f2a"}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{"redirect_url":null,"webhook_url":null,"notify_email":null,"create_contact":true,"create_deal":true,"qualified_pipeline_stage_id":null,"require_email":false,"require_phone":false,"allow_retry":true}'::jsonb,
  qualification_config JSONB NOT NULL DEFAULT '{"mode":"score","rules":[],"threshold":50,"qualified_message":"Perfeito! Você pode agendar uma reunião abaixo.","disqualified_message":"Obrigado! Vamos analisar e retornar em breve."}'::jsonb,
  scheduling_config JSONB NOT NULL DEFAULT '{"enabled":false,"duration_min":30,"buffer_min":10,"timezone":"America/Sao_Paulo","availability":{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[],"sun":[]},"owner_name":null,"meeting_title":"Reunião de diagnóstico","meeting_link":null}'::jsonb,
  meta_config JSONB NOT NULL DEFAULT '{"pixel_id":null,"fire_view_content":true,"fire_lead":true,"fire_complete_registration":true,"fire_schedule":true,"fire_qualified":true}'::jsonb,
  view_count INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  booked_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_lead_forms_account ON lead_forms(account_id);
CREATE INDEX IF NOT EXISTS idx_lead_forms_slug ON lead_forms(slug);

ALTER TABLE lead_forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own lead forms" ON lead_forms;
CREATE POLICY "Users manage own lead forms" ON lead_forms FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = lead_forms.account_id)
  );

-- ---------- 2. lead_form_blocks ----------
CREATE TABLE IF NOT EXISTS lead_form_blocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_id UUID NOT NULL REFERENCES lead_forms(id) ON DELETE CASCADE,
  block_key TEXT NOT NULL,
  block_type TEXT NOT NULL CHECK (block_type IN (
    'statement','short_text','long_text','email','phone','number',
    'choice_single','choice_multi','rating','nps','date','file','meeting'
  )),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  is_qualifier BOOLEAN NOT NULL DEFAULT false,
  score_weight INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (form_id, block_key)
);

CREATE INDEX IF NOT EXISTS idx_lead_form_blocks_form ON lead_form_blocks(form_id, position);

ALTER TABLE lead_form_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage blocks on their forms" ON lead_form_blocks;
CREATE POLICY "Users manage blocks on their forms" ON lead_form_blocks FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM lead_forms f
      JOIN profiles p ON p.account_id = f.account_id AND p.user_id = auth.uid()
      WHERE f.id = lead_form_blocks.form_id
    )
  );

-- ---------- 3. lead_form_responses ----------
CREATE TABLE IF NOT EXISTS lead_form_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_id UUID NOT NULL REFERENCES lead_forms(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  score INTEGER NOT NULL DEFAULT 0,
  is_qualified BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('started','completed','qualified','disqualified','booked')),
  respondent_name TEXT,
  respondent_email TEXT,
  respondent_phone TEXT,
  tracking JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_event_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_form_responses_form ON lead_form_responses(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_form_responses_account ON lead_form_responses(account_id, created_at DESC);

ALTER TABLE lead_form_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own form responses" ON lead_form_responses;
CREATE POLICY "Users see own form responses" ON lead_form_responses FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = lead_form_responses.account_id)
  );
DROP POLICY IF EXISTS "Users delete own form responses" ON lead_form_responses;
CREATE POLICY "Users delete own form responses" ON lead_form_responses FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = lead_form_responses.account_id)
  );

-- ---------- 4. lead_form_bookings ----------
CREATE TABLE IF NOT EXISTS lead_form_bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_id UUID NOT NULL REFERENCES lead_forms(id) ON DELETE CASCADE,
  response_id UUID NOT NULL REFERENCES lead_form_responses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  attendee_email TEXT,
  attendee_phone TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed','no_show')),
  meeting_title TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_form_bookings_form ON lead_form_bookings(form_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_lead_form_bookings_account ON lead_form_bookings(account_id, starts_at);

ALTER TABLE lead_form_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own form bookings" ON lead_form_bookings;
CREATE POLICY "Users see own form bookings" ON lead_form_bookings FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = lead_form_bookings.account_id)
  );

-- ---------- updated_at ----------
DROP TRIGGER IF EXISTS set_updated_at ON lead_forms;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- realtime ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lead_form_responses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_form_responses;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lead_form_bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_form_bookings;
  END IF;
END $$;

-- ---------- counters RPC ----------
CREATE OR REPLACE FUNCTION increment_lead_form_counter(p_form_id UUID, p_field TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_field = 'view' THEN
    UPDATE lead_forms SET view_count = view_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'response' THEN
    UPDATE lead_forms SET response_count = response_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'qualified' THEN
    UPDATE lead_forms SET qualified_count = qualified_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'booked' THEN
    UPDATE lead_forms SET booked_count = booked_count + 1 WHERE id = p_form_id;
  END IF;
END;
$$;
