-- ============================================================
-- TABELA: bloqueios
-- Permite congelar dias inteiros ou faixas de horário.
-- Execute este SQL no Supabase: Database > SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS bloqueios (
  id          bigserial PRIMARY KEY,
  salao_id    uuid        NOT NULL REFERENCES saloes(id) ON DELETE CASCADE,
  data        date        NOT NULL,
  dia_inteiro boolean     NOT NULL DEFAULT false,
  hora_inicio time,           -- NULL quando dia_inteiro = true
  hora_fim    time,           -- NULL quando dia_inteiro = true
  motivo      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bloqueios_salao_data_idx ON bloqueios (salao_id, data);

-- RLS: leitura pública (usada pelo site), escrita só via service key (servidor)
ALTER TABLE bloqueios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bloqueios_public_read" ON bloqueios
  FOR SELECT USING (true);

-- ============================================================
-- OPCIONAL: atualizar cidade do Studio Beauty para Contagem
-- (só rode se ainda estiver como Horizonte)
-- ============================================================
-- UPDATE saloes
-- SET cidade = 'Contagem, MG'
-- WHERE slug = 'studiobeauty';
