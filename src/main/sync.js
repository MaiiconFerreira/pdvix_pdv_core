// sync.js — PDVix Electron — Sincronização de vendas offline → servidor
// Roda em background e tenta sincronizar a cada 60 segundos.
// A lógica de envio fica em main.js (syncVendaUnica).

const db               = require('./database');
const { logger }       = require('./logger');
const { syncVendaUnica } = require('./main');

async function sincronizarPendentes() {
  // Só tenta se o token estiver configurado (configuração mínima necessária)
  const tokenRow = db.prepare(`SELECT valor FROM config WHERE chave = 'api_token'`).get();
  if (!tokenRow?.valor) {
    logger.warn('Sync: api_token não configurado — aguardando configuração.');
    return;
  }

  const urlRow = db.prepare(`SELECT valor FROM config WHERE chave = 'servidor_url'`).get();
  if (!urlRow?.valor) {
    logger.warn('Sync: servidor_url não configurado — aguardando configuração.');
    return;
  }

  // Pega todas as vendas finalizadas ainda não sincronizadas, ordenadas por ID (mais antigas primeiro)
  const pendentes = db.prepare(`
    SELECT id, numero_venda, total
    FROM vendas
    WHERE sincronizado = 0 AND status = 'finalizada'
    ORDER BY id ASC
  `).all();

  if (!pendentes.length) return;

  logger.info(`Sync: ${pendentes.length} venda(s) pendente(s).`);

  for (const { id, numero_venda, total } of pendentes) {
    try {
      await syncVendaUnica(id);
      logger.info(`Sync OK: venda #${id} (${numero_venda}) — R$ ${Number(total).toFixed(2)}`);
    } catch (err) {
      // Para no primeiro erro de rede/servidor para evitar spam de tentativas
      // na mesma rodada. O setInterval tentará novamente em 60s.
      logger.error(`Sync falhou para venda #${id}: ${err.message}`, {
        status: err.response?.status ?? null,
        url:    err.config?.url      ?? null,
        body:   err.response?.data   ?? null,
      });
      break;
    }
  }
}

// Roda a cada 60 segundos
setInterval(sincronizarPendentes, 60_000);

module.exports = { sincronizarPendentes };