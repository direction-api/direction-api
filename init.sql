-- ============================================================
-- Direction API — Inicialização do Banco de Dados
-- Executado automaticamente pelo PostgreSQL na primeira vez
-- ============================================================

-- Tabela de instâncias do Instagram
CREATE TABLE IF NOT EXISTS instances (
    id          SERIAL PRIMARY KEY,
    token       UUID NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    ig_username VARCHAR(100) NOT NULL,
    ig_password TEXT NOT NULL,
    status      VARCHAR(30) DEFAULT 'Desconectado',
    webhook_url TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de contatos (remetentes que enviaram mensagem)
CREATE TABLE IF NOT EXISTS contacts (
    id              SERIAL PRIMARY KEY,
    instance_id     UUID NOT NULL,
    username        VARCHAR(100) NOT NULL UNIQUE,
    thread_id       TEXT,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de mensagens recebidas
CREATE TABLE IF NOT EXISTS messages (
    id          SERIAL PRIMARY KEY,
    contact_id  INT REFERENCES contacts(id) ON DELETE CASCADE,
    instance_id UUID NOT NULL,
    text        TEXT,
    external_id TEXT UNIQUE,
    received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact  ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id);
