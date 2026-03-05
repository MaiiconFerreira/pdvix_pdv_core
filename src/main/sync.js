// sync.js — PDVix Electron — Sincronização de vendas offline → servidor
const axios  = require('axios');
const db     = require('./database');
const { logger } = require('./logger');
const { syncVendaUnica } = require('./main');

async function sincronizarPendentes() {
  const pendentes = db.prepare(`SELECT id FROM vendas WHERE sincronizado = 0 AND status = 'finalizada'`).all();
  if (!pendentes.length) return;

  logger.info(`Sync: ${pendentes.length} venda(s) pendente(s).`);

  for (const { id } of pendentes) {
    try {
      await syncVendaUnica(id);
    } catch (err) {
      logger.error(`Sync falhou para venda #${id}: ${err.message}`);
      break; // Para se houver falha de rede
    }
  }
}

// Roda a cada 60 segundos
setInterval(sincronizarPendentes, 60_000);

module.exports = { sincronizarPendentes };