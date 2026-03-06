// sync.js — PDVix Electron — Sincronização de vendas offline → servidor
// Roda em background e tenta sincronizar a cada 30 segundos.
// Regra: NENHUMA venda/cancelamento pode ficar sem sincronização.
//   - Erros de rede (sem resposta): para a rodada, tenta novamente em 30s
//   - Erros HTTP 4xx (dados inválidos): marca erro e continua as próximas
//   - Erros HTTP 5xx (servidor): continua tentando (pode ser transitório)

const db               = require('./database');
const { logger }       = require('./logger');
const { syncVendaUnica, syncCancelamentosOffline } = require('./main');

// Contador de erros por venda_id para evitar spam no log
const errosPorVenda    = {};
const MAX_TENTATIVAS_LOG = 5; // Após isso só loga a cada 10 tentativas

async function sincronizarPendentes() {
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

  // ── Vendas pendentes ──────────────────────────────────────────────────────
  const pendentes = db.prepare(`
    SELECT id, numero_venda, total
    FROM vendas
    WHERE sincronizado = 0 AND status = 'finalizada'
    ORDER BY id ASC
  `).all();

  if (pendentes.length) {
    logger.info(`Sync: ${pendentes.length} venda(s) pendente(s).`);

    let erroDeRede = false;

    for (const { id, numero_venda, total } of pendentes) {
      if (erroDeRede) break; // Servidor offline — para esta rodada

      try {
        await syncVendaUnica(id);
        delete errosPorVenda[id]; // Limpa contador em caso de sucesso
        logger.info(`Sync OK: venda #${id} (${numero_venda}) — R$ ${Number(total).toFixed(2)}`);

      } catch (err) {
        const httpStatus = err.response?.status ?? null;

        // Sem resposta = servidor offline → para esta rodada inteira
        if (!httpStatus) {
          erroDeRede = true;
          logger.warn(`Sync: sem resposta do servidor. Venda #${id} tentará na próxima rodada.`);
          break;
        }

        // Erro HTTP (4xx/5xx): registra e CONTINUA para a próxima venda
        // Isso garante que uma venda com dados ruins não trave as outras
        errosPorVenda[id] = (errosPorVenda[id] || 0) + 1;
        const tentativas  = errosPorVenda[id];

        if (tentativas <= MAX_TENTATIVAS_LOG || tentativas % 10 === 0) {
          logger.error(`Sync falhou venda #${id} [HTTP ${httpStatus}] tentativa ${tentativas}: ${err.message}`, {
            status: httpStatus,
            url:    err.config?.url  ?? null,
            body:   err.response?.data ?? null,
          });
        }

        if (tentativas === 20) {
          logger.error(`ATENÇÃO: Venda #${id} (${numero_venda}) com 20 falhas. Verifique o log e corrija manualmente.`);
        }
      }
    }
  }

  // ── Cancelamentos pendentes ───────────────────────────────────────────────
  try {
    await syncCancelamentosOffline();
  } catch (err) {
    logger.warn('Sync cancelamentos falhou: ' + err.message);
  }
}

// Intervalo de 30s para sincronização mais rápida
setInterval(sincronizarPendentes, 30_000);

// Tenta imediatamente após o app subir (5s de delay para inicialização)
setTimeout(sincronizarPendentes, 5_000);

module.exports = { sincronizarPendentes };
