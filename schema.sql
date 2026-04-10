-- Execute este SQL no Supabase → SQL Editor
-- Cria a tabela de agendamentos do Studio Beauty

create table if not exists agendamentos (
  id         uuid    default gen_random_uuid() primary key,
  name       text    not null,
  phone      text    not null,
  date       text    not null,
  time       text    not null,
  duration   integer not null,
  service    text    not null,
  price      text,
  done       boolean default false,
  cancelled  boolean default false,
  created_at timestamptz default now()
);

-- Habilitar Row Level Security (necessário para a chave anon funcionar)
alter table agendamentos enable row level security;

-- Permitir todas as operações via chave anon (público pode agendar, admin pode gerenciar)
create policy "allow_all" on agendamentos
  for all
  using (true)
  with check (true);
