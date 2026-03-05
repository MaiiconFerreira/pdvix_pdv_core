// database.js — PDVix Electron
// Dependências: better-sqlite3
const Database = require('better-sqlite3');
const path     = require('path');
const { app }  = require('electron');
const { logger } = require('./logger');

const dbPath = path.join(app.getPath('userData'), 'pdvix_local.sqlite');

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  logger.info('SQLite conectado: ' + dbPath);
  initSchema();
} catch (err) {
  logger.error('Erro ao abrir SQLite: ' + err.message);
  process.exit(1);
}

function initSchema() {
  db.exec(`
    -- ─── CACHE DO SERVIDOR ─────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS usuarios (
      id              INTEGER PRIMARY KEY,
      login           TEXT    UNIQUE NOT NULL,
      password_local  TEXT,                        -- bcrypt local para auth offline
      perfil          TEXT    NOT NULL DEFAULT 'operador',
      nome            TEXT    NOT NULL,
      cpf             TEXT,
      status          TEXT    NOT NULL DEFAULT 'ativado',
      atualizado_em   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id            INTEGER PRIMARY KEY,
      nome          TEXT NOT NULL,
      cpf           TEXT UNIQUE,
      telefone      TEXT,
      status        TEXT DEFAULT 'ativo'
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id                          INTEGER PRIMARY KEY,
      nome                        TEXT    NOT NULL,
      codigo_interno_alternativo  INTEGER,
      preco_venda                 REAL    NOT NULL DEFAULT 0,
      fator_embalagem             INTEGER NOT NULL DEFAULT 1,
      unidade_base                TEXT    NOT NULL DEFAULT 'UN',
      bloqueado                   INTEGER DEFAULT 0,
      atualizado_em               TEXT
    );

    CREATE TABLE IF NOT EXISTS produtos_codigos_barras (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id      INTEGER NOT NULL,
      codigo_barras   TEXT    NOT NULL,
      tipo_embalagem  TEXT    NOT NULL,
      preco_venda     REAL    NOT NULL DEFAULT 0,
      UNIQUE(produto_id, tipo_embalagem)
    );

    -- Fase 3: cartões supervisor (cache do servidor)
    CREATE TABLE IF NOT EXISTS supervisores_cartoes (
      id                     INTEGER PRIMARY KEY,
      usuario_id             INTEGER NOT NULL,
      codigo_cartao          TEXT    UNIQUE NOT NULL,
      descricao              TEXT,
      permite_desconto_item  INTEGER DEFAULT 0,
      permite_desconto_venda INTEGER DEFAULT 0,
      permite_cancelar_item  INTEGER DEFAULT 0,
      permite_cancelar_venda INTEGER DEFAULT 0,
      ativo                  INTEGER DEFAULT 1
    );

    -- ─── OPERAÇÕES LOCAIS ──────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS caixa_sessoes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id       INTEGER NOT NULL,
      abertura_em      TEXT    NOT NULL DEFAULT (datetime('now')),
      fechamento_em    TEXT,
      valor_abertura   REAL    DEFAULT 0,
      total_dinheiro   REAL    DEFAULT 0,
      total_pix        REAL    DEFAULT 0,
      total_debito     REAL    DEFAULT 0,
      total_credito    REAL    DEFAULT 0,
      total_convenio   REAL    DEFAULT 0,
      total_outros     REAL    DEFAULT 0,
      total_vendas     INTEGER DEFAULT 0,
      total_canceladas INTEGER DEFAULT 0,
      total_sangrias   REAL    DEFAULT 0,   -- soma de todas as sangrias do caixa
      status           TEXT    DEFAULT 'aberto'   -- aberto | fechado
    );

    CREATE TABLE IF NOT EXISTS sangrias (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_sessao_id  INTEGER NOT NULL,
      usuario_id       INTEGER NOT NULL,
      valor            REAL    NOT NULL,
      motivo           TEXT,
      data_hora        TEXT    NOT NULL DEFAULT (datetime('now')),
      sincronizado     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vendas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_venda     TEXT    NOT NULL,
      caixa_sessao_id  INTEGER,
      usuario_id       INTEGER NOT NULL,
      cliente_id       INTEGER,
      cliente_cpf      TEXT,
      cliente_nome     TEXT    DEFAULT 'CONSUMIDOR FINAL',
      subtotal         REAL    DEFAULT 0,
      desconto         REAL    DEFAULT 0,
      acrescimo        REAL    DEFAULT 0,
      total            REAL    DEFAULT 0,
      status           TEXT    DEFAULT 'aberta',  -- aberta | finalizada | cancelada
      observacao       TEXT,
      data_venda       TEXT    NOT NULL DEFAULT (datetime('now')),
      sincronizado     INTEGER DEFAULT 0,
      id_servidor      INTEGER                    -- ID após sync com servidor
    );

    CREATE TABLE IF NOT EXISTS venda_itens (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id           INTEGER NOT NULL,
      produto_id         INTEGER NOT NULL,
      produto_nome       TEXT    NOT NULL,
      quantidade         REAL    NOT NULL,
      valor_unitario     REAL    NOT NULL,
      desconto_item      REAL    DEFAULT 0,
      subtotal           REAL    NOT NULL,
      codigo_barras_usado TEXT   DEFAULT '',
      unidade_origem     TEXT    DEFAULT 'UN'
    );

    CREATE TABLE IF NOT EXISTS pagamentos_venda (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id            INTEGER NOT NULL,
      tipo_pagamento      TEXT    NOT NULL,
      valor               REAL    NOT NULL,
      referencia_externa  TEXT,
      status              TEXT    DEFAULT 'confirmado',
      data_hora           TEXT    NOT NULL DEFAULT (datetime('now')),
      sincronizado        INTEGER DEFAULT 0
    );

    -- ─── CONFIG ────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );

    INSERT OR IGNORE INTO config VALUES ('servidor_url',          'http://localhost');
    INSERT OR IGNORE INTO config VALUES ('numero_pdv',            '01');
    INSERT OR IGNORE INTO config VALUES ('versao',                '2.0.0');
    INSERT OR IGNORE INTO config VALUES ('ultima_sincronizacao',  '');
    INSERT OR IGNORE INTO config VALUES ('api_token',             '');
  `);

  // ── Migrations incrementais (adiciona colunas em tabelas existentes) ──────
  // Seguro rodar em todo startup — silencia o erro se coluna já existe.
  const migrations = [
    `ALTER TABLE caixa_sessoes ADD COLUMN total_sangrias REAL DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* coluna já existe — ignora */ }
  }
}

// ─── Wrapper de log para queries ──────────────────────────────────────────────
const { dbLog } = require('./logger');

let queryCounter = 0;

const dbProxy = new Proxy(db, {
  get(target, prop) {
    if (prop !== 'prepare') return target[prop];

    return function (sql) {
      const stmt = target.prepare(sql);
      const sqlResumido = sql.replace(/\s+/g, ' ').trim().slice(0, 120);

      // Envolve .run(), .get(), .all()
      for (const metodo of ['run', 'get', 'all']) {
        const original = stmt[metodo].bind(stmt);
        stmt[metodo] = function (...args) {
          const id        = ++queryCounter;
          const inicio    = Date.now();
          const operation = sql.trimStart().split(' ')[0].toUpperCase();

          try {
            const resultado = original(...args);
            const ms        = Date.now() - inicio;

            dbLog.debug('QUERY_OK', {
              id,
              op:     operation,
              metodo,
              sql:    sqlResumido,
              params: args.length ? args : undefined,
              ms,
              rows:   Array.isArray(resultado)
                        ? resultado.length
                        : resultado?.changes ?? null,
            });

            return resultado;
          } catch (err) {
            dbLog.error('QUERY_ERROR', {
              id,
              op:      operation,
              metodo,
              sql:     sqlResumido,
              params:  args.length ? args : undefined,
              ms:      Date.now() - inicio,
              message: err.message,
            });
            throw err;
          }
        };
      }

      return stmt;
    };
  },
});

module.exports = dbProxy;