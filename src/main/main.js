// main.js — PDVix Electron v3
// Dependências: electron, better-sqlite3, bcryptjs, axios, ws
const { app, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const { setupHttpLogger } = require('./httpLogger');
setupHttpLogger(); // ativa interceptors antes de qualquer requisição axios
const axios  = require('axios');
const https  = require('https');
const bcrypt = require('bcryptjs');
const db     = require('./database');
const { logger } = require('./logger');

let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }

let mainWindow;
let sessao   = null;   // { usuario: {id, login, nome, perfil}, caixa_sessao_id }
let isOnline = false;

// ── Ambiente ──────────────────────────────────────────────────────────────────
// Em dev (ws:// / http://) desabilita verificação de certificado no axios e WS.
// Em prod (wss:// / https://) a verificação é habilitada automaticamente.
const IS_DEV = true; //process.env.NODE_ENV !== 'production';

// Agente HTTPS permissivo para dev (self-signed ou HTTP simples via proxy)
const axiosDevAgent = new https.Agent({ rejectUnauthorized: false });

function axiosOpts(extra = {}) {
  return IS_DEV
    ? { ...extra, httpsAgent: axiosDevAgent }
    : extra;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
let wsClient         = null;
let wsAutenticado    = false;
let wsReconectTimer  = null;
let wsHeartbeatTimer = null;

function wsConectar() {
  if (!WebSocket) return;
  const wsUrl = cfg('ws_url');
  if (!wsUrl) return;

  // Em dev (ws://) rejectUnauthorized não se aplica, mas mantemos false para
  // não quebrar caso alguém aponte para wss:// com cert auto-assinado em staging.
  const wsOpts = wsUrl.startsWith('wss://') && !IS_DEV
    ? {}                               // produção: verifica certificado
    : { rejectUnauthorized: false };   // dev / staging: ignora cert

  try {
    wsClient = new WebSocket(wsUrl, wsOpts);

    wsClient.on('open', () => {
      logger.info('WebSocket: conectado → ' + wsUrl);
      const token     = cfg('api_token');
      const lojaId    = parseInt(cfg('loja_id') || '1');
      const numeroPdv = cfg('numero_pdv') || '01';

      // Chave 'event' — consistente com o que o servidor espera em $payload['event']
      wsClient.send(JSON.stringify({
        event:      'pdv:auth',
        payload: {
          token,
          loja_id:    lojaId,
          numero_pdv: numeroPdv,
          versao:     cfg('versao') || '3.0.0',
        },
      }));

      // Heartbeat a cada 30s
      wsHeartbeatTimer = setInterval(() => {
        if (wsClient?.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            event:   'pdv:heartbeat',
            payload: { loja_id: lojaId, numero_pdv: numeroPdv },
          }));
        }
      }, 30_000);
    });

    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        wsProcessarEvento(msg);
      } catch (e) {
        logger.warn('WS: mensagem inválida: ' + e.message);
      }
    });

    wsClient.on('close', () => {
      wsAutenticado = false;
      clearInterval(wsHeartbeatTimer);
      logger.warn('WebSocket: conexão encerrada. Reconectando em 15s...');
      wsReconectTimer = setTimeout(wsConectar, 15_000);
      if (mainWindow) mainWindow.webContents.send('ws:status', { conectado: false });
    });

    wsClient.on('error', (err) => {
      logger.warn('WebSocket error: ' + err.message);
    });

  } catch (err) {
    logger.error('wsConectar falhou: ' + err.message);
    wsReconectTimer = setTimeout(wsConectar, 15_000);
  }
}

function wsEnviar(payload) {
  if (wsClient?.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify(payload));
  }
}

function wsProcessarEvento(msg) {
  // Servidor envia { event: '...', payload: {...} }
  const { event, ...rest } = msg;
  if (!event) return;

  logger.info('WS evento recebido: ' + event);

  switch (event) {
    case 'ws:auth_ok':
      wsAutenticado = true;
      if (mainWindow) mainWindow.webContents.send('ws:status', { conectado: true, autenticado: true });
      break;

    case 'ws:auth_fail':
      wsAutenticado = false;
      logger.error('WS: autenticação falhou — ' + rest.msg);
      if (mainWindow) mainWindow.webContents.send('ws:status', { conectado: false, erro: rest.msg });
      break;

    // Pagamentos automáticos via Pagar.me
    case 'pdv:pagamento_pendente':
      if (mainWindow) mainWindow.webContents.send('pagarme:pendente', rest.payload ?? rest);
      break;
    case 'pdv:pagamento_confirmado':
      if (mainWindow) mainWindow.webContents.send('pagarme:confirmado', rest.payload ?? rest);
      break;
    case 'pdv:pagamento_cancelado':
      if (mainWindow) mainWindow.webContents.send('pagarme:cancelado', rest.payload ?? rest);
      break;

    // Carga disponível
    case 'pdv:carga_disponivel':
      logger.info('WS: nova carga disponível no servidor.');
      executarCargaInicial().then(r => {
        if (r.sucesso && mainWindow) mainWindow.webContents.send('carga:atualizada', r.totais);
      });
      break;

    // Comanda enviada pelo painel
    case 'pdv:comando':
      wsExecutarComando(rest.payload ?? rest);
      break;
  }
}

async function wsExecutarComando(cmd) {
  const tipo    = cmd.tipo;
  const payload = cmd.payload || {};
  logger.info('WS: executando comando remoto: ' + tipo);

  try {
    let sucesso = true;
    let mensagem = 'Executado com sucesso.';

    switch (tipo) {
      case 'desligar':
        app.quit();
        break;
      case 'reiniciar':
        app.relaunch();
        app.quit();
        break;
      case 'fechar_caixa':
        if (mainWindow) mainWindow.webContents.send('cmd:fechar_caixa', payload);
        break;
      case 'cancelar_venda':
        if (payload.venda_id) {
          db.prepare(`UPDATE vendas SET status = 'cancelada' WHERE id = ? AND status != 'cancelada'`).run(payload.venda_id);
          db.prepare(`
            INSERT INTO cancelamentos (tipo, venda_id, motivo, valor, supervisor_id, cancelado_em)
            VALUES ('venda', ?, ?, 0, ?, datetime('now'))
          `).run(payload.venda_id, payload.motivo || 'Comando remoto', payload.supervisor_id || null);
          if (mainWindow) mainWindow.webContents.send('cmd:cancelar_venda', payload);
        }
        break;
      case 'cancelar_item':
        if (mainWindow) mainWindow.webContents.send('cmd:cancelar_item', payload);
        break;
      case 'desconto_item':
        if (mainWindow) mainWindow.webContents.send('cmd:desconto_item', payload);
        break;
      case 'desconto_venda':
        if (mainWindow) mainWindow.webContents.send('cmd:desconto_venda', payload);
        break;
      case 'finalizar_venda':
        if (mainWindow) mainWindow.webContents.send('cmd:finalizar_venda', payload);
        break;
      case 'enviar_comanda':
        // FIX: para enviar_comanda os dados (numero, cliente_nome, itens) estão
        // na raiz de `cmd`, não em `cmd.payload`. Enviamos `cmd` completo.
        if (mainWindow) mainWindow.webContents.send('cmd:comanda', cmd);
        break;
      case 'enviar_carga':
        const r = await executarCargaInicial();
        sucesso  = r.sucesso;
        mensagem = r.mensagem || 'Carga atualizada.';
        if (r.sucesso && mainWindow) mainWindow.webContents.send('carga:atualizada', r.totais);
        break;
      default:
        sucesso  = false;
        mensagem = 'Comando desconhecido: ' + tipo;
    }

    wsEnviar({ event: 'pdv:cmd_resultado', payload: { tipo, sucesso, mensagem } });
  } catch (err) {
    logger.error('wsExecutarComando erro: ' + err.message);
    wsEnviar({ event: 'pdv:cmd_resultado', payload: { tipo, sucesso: false, mensagem: err.message } });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cfg(chave) {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return r ? r.valor : '';
}

// ─── Número de venda no padrão do servidor ────────────────────────────────────
// Formato: LOJA{loja_id}-PDV{numero_pdv}-{YYYYMMDD}-{seq_6}
function gerarNumeroVenda() {
  const lojaId    = cfg('loja_id')    || '1';
  const numeroPdv = cfg('numero_pdv') || '01';
  const hoje      = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seqKey    = `venda_seq_${hoje}`;
  const seqRow    = db.prepare('SELECT valor FROM config WHERE chave = ?').get(seqKey);
  const seq       = seqRow ? parseInt(seqRow.valor) + 1 : 1;
  db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)').run(seqKey, String(seq));
  return `LOJA${lojaId}-PDV${numeroPdv}-${hoje}-${String(seq).padStart(6, '0')}`;
}

async function verificarOnline() {
  try {
    await axios.get(cfg('servidor_url') + '/login', axiosOpts({ timeout: 3000 }));
    isOnline = true;
  } catch {
    isOnline = false;
  }
}

// ─── Janela ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1024, minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#F0F2F5',
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  createWindow();
  await verificarOnline();
  setInterval(verificarOnline, 30_000);

  mainWindow.webContents.once('did-finish-load', async () => {
    if (isOnline) {
      logger.info('Startup: iniciando carga inicial automática...');
      const resultado = await executarCargaInicial();
      if (resultado.sucesso) {
        logger.info(`Startup: carga inicial concluída — ${resultado.totais.produtos} produtos`);
      } else {
        logger.warn('Startup: carga inicial falhou — ' + resultado.mensagem);
      }
      // Conecta WebSocket após carga inicial
      wsConectar();
    } else {
      logger.warn('Startup: offline, carga inicial ignorada.');
    }
  });

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('auth:login', async (_e, { login, senha }) => {
  try {
    // 1. Tenta no servidor se online
    if (isOnline) {
      try {
        const url      = cfg('servidor_url');
        const formData = new URLSearchParams();
        formData.append('login', login);
        formData.append('password', senha);
        formData.append('uuid_v4', 'electron');

        const resp = await axios.post(url + '/auth', formData, axiosOpts({
          timeout: 6000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }));

        if (resp.data.status === 'success') {
          const u    = resp.data.data.user;
          const hash = await bcrypt.hash(senha, 10);

          db.prepare(`
            INSERT OR REPLACE INTO usuarios
              (id, login, password_local, perfil, nome, cpf, status, atualizado_em)
            VALUES (?,?,?,?,?,?,?, datetime('now'))
          `).run(u.id, u.login, hash, u.perfil, u.nome, u.login, u.status);

          sessao = { usuario: { id: u.id, login: u.login, nome: u.nome, perfil: u.perfil } };
          return { sucesso: true, usuario: sessao.usuario };
        }
        return { sucesso: false, mensagem: resp.data.message || 'Credenciais inválidas.' };

      } catch (err) {
        logger.warn('Auth servidor falhou, usando local: ' + err.message, {
          status: err.response?.status ?? null,
          body:   err.response?.data   ?? null,
          url:    err.config?.url      ?? null,
        });
      }
    }

    // 2. Auth local (offline)
    const u = db.prepare(`SELECT * FROM usuarios WHERE login = ? AND status = 'ativado'`).get(login);
    if (!u) return { sucesso: false, mensagem: 'Usuário não encontrado ou inativo.' };
    if (!u.password_local) return { sucesso: false, mensagem: 'Sem conexão com servidor. Faça login online ao menos uma vez.' };

    const ok = await bcrypt.compare(senha, u.password_local);
    if (!ok) return { sucesso: false, mensagem: 'Senha incorreta.' };

    sessao = { usuario: { id: u.id, login: u.login, nome: u.nome, perfil: u.perfil } };
    return { sucesso: true, usuario: sessao.usuario };

  } catch (err) {
    logger.error('auth:login: ' + err.message);
    return { sucesso: false, mensagem: 'Erro interno.' };
  }
});

ipcMain.handle('auth:current', () => sessao?.usuario ?? null);

ipcMain.handle('auth:logout', () => {
  sessao = null;
  return { sucesso: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAIXA
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('caixa:status', () => {
  if (!sessao) return null;
  const cs = db.prepare(`
    SELECT * FROM caixa_sessoes WHERE usuario_id = ? AND status = 'aberto' ORDER BY id DESC LIMIT 1
  `).get(sessao.usuario.id);
  if (cs) sessao.caixa_sessao_id = cs.id;
  return cs || null;
});

ipcMain.handle('caixa:abrir', (_e, { valor_abertura = 0 }) => {
  if (!sessao) return { sucesso: false, mensagem: 'Não logado.' };

  const existe = db.prepare(`
    SELECT id FROM caixa_sessoes WHERE usuario_id = ? AND status = 'aberto'
  `).get(sessao.usuario.id);

  if (existe) {
    sessao.caixa_sessao_id = existe.id;
    return { sucesso: true, id: existe.id };
  }

  const info = db.prepare(`
    INSERT INTO caixa_sessoes (usuario_id, abertura_em, valor_abertura)
    VALUES (?, datetime('now'), ?)
  `).run(sessao.usuario.id, valor_abertura);

  sessao.caixa_sessao_id = info.lastInsertRowid;
  logger.info(`Caixa aberto: sessao ${info.lastInsertRowid} para ${sessao.usuario.login}`);

  wsEnviar({
    event:   'pdv:caixa_aberto',
    payload: {
      loja_id:     parseInt(cfg('loja_id') || '1'),
      numero_pdv:  cfg('numero_pdv') || '01',
      operador_id: sessao.usuario.id,
    },
  });

  return { sucesso: true, id: info.lastInsertRowid };
});

ipcMain.handle('caixa:resumo', () => {
  if (!sessao?.caixa_sessao_id) return null;
  const sid = sessao.caixa_sessao_id;

  // ── Totais por forma de pagamento ─────────────────────────────────────────
  // Usa SUM(p.valor) agrupado por tipo — evita dupla contagem que ocorre com
  // LEFT JOIN quando uma venda tem múltiplos pagamentos.
  // O valor em pagamentos_venda já é o valor LÍQUIDO (sem troco) por design.
  const pgtoRows = db.prepare(`
    SELECT pv.tipo_pagamento, COALESCE(SUM(pv.valor), 0) AS total
    FROM pagamentos_venda pv
    JOIN vendas v ON v.id = pv.venda_id
    WHERE v.caixa_sessao_id = ? AND v.status = 'finalizada' AND pv.status = 'confirmado'
    GROUP BY pv.tipo_pagamento
  `).all(sid);

  const pgtoMap = {};
  for (const r of pgtoRows) pgtoMap[r.tipo_pagamento] = r.total;

  const totalVendasRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS total_geral, COUNT(*) AS total_vendas
    FROM vendas WHERE caixa_sessao_id = ? AND status = 'finalizada'
  `).get(sid);

  const totais = {
    total_dinheiro:  pgtoMap['dinheiro']  || 0,
    total_pix:      (pgtoMap['pix']       || 0) + (pgtoMap['pos_pix'] || 0),
    total_debito:    pgtoMap['pos_debito']  || 0,
    total_credito:   pgtoMap['pos_credito'] || 0,
    total_convenio:  pgtoMap['convenio']    || 0,
    total_outros:    pgtoMap['outros']      || 0,
    total_geral:     totalVendasRow.total_geral,
    total_vendas:    totalVendasRow.total_vendas,
    // Total não-automatizado: dinheiro + POS + convênio + outros (excl. pix/pos_pix automático)
    total_nao_automatizado: (pgtoMap['dinheiro'] || 0) + (pgtoMap['pos_debito'] || 0)
                           + (pgtoMap['pos_credito'] || 0) + (pgtoMap['convenio'] || 0)
                           + (pgtoMap['outros'] || 0),
  };

  const canceladas = db.prepare(`
    SELECT COUNT(*) AS cnt FROM vendas WHERE caixa_sessao_id = ? AND status = 'cancelada'
  `).get(sid);

  const sangrias = db.prepare(`
    SELECT COALESCE(SUM(valor), 0) AS total FROM sangrias WHERE caixa_sessao_id = ?
  `).get(sid);

  const sessaoInfo = db.prepare(`SELECT * FROM caixa_sessoes WHERE id = ?`).get(sid);

  // Saldo esperado: abertura + dinheiro recebido - sangrias
  const saldo_caixa = (sessaoInfo.valor_abertura || 0)
                    + (totais.total_dinheiro      || 0)
                    - (sangrias.total             || 0);

  return {
    ...totais,
    total_canceladas: canceladas.cnt,
    total_sangrias:   sangrias.total,
    saldo_caixa,
    sessao:           sessaoInfo,
  };
});

ipcMain.handle('caixa:fechar', async () => {
  if (!sessao?.caixa_sessao_id) return { sucesso: false, mensagem: 'Nenhum caixa aberto.' };
  const sid = sessao.caixa_sessao_id;

  const aberta = db.prepare(`
    SELECT id FROM vendas WHERE caixa_sessao_id = ? AND status = 'aberta'
  `).get(sid);
  if (aberta) return { sucesso: false, mensagem: 'Existe venda em andamento. Finalize ou cancele antes de fechar.' };

  // Totais por forma de pagamento — soma dos totais das VENDAS (nunca o lançado no pagamento bruto)
  // Ou seja: para cada venda finalizada, soma o total da venda pro tipo de pagamento correspondente.
  // Isso garante que dinheiro = total vendido em dinheiro (não o troco que foi dado).
  // ── Totais por forma de pagamento (sem dupla contagem) ───────────────────
  const pgtoRowsF = db.prepare(`
    SELECT pv.tipo_pagamento, COALESCE(SUM(pv.valor), 0) AS total
    FROM pagamentos_venda pv
    JOIN vendas v ON v.id = pv.venda_id
    WHERE v.caixa_sessao_id = ? AND v.status = 'finalizada' AND pv.status = 'confirmado'
    GROUP BY pv.tipo_pagamento
  `).all(sid);

  const pm = {};
  for (const r of pgtoRowsF) pm[r.tipo_pagamento] = r.total;

  const tvRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM vendas WHERE caixa_sessao_id = ? AND status = 'finalizada'
  `).get(sid);

  const t = {
    d:  pm['dinheiro']   || 0,
    pi: (pm['pix'] || 0) + (pm['pos_pix'] || 0),
    de: pm['pos_debito']  || 0,
    cr: pm['pos_credito'] || 0,
    co: pm['convenio']    || 0,
    ou: pm['outros']      || 0,
    tv: tvRow.cnt,
  };

  const tc = db.prepare(`
    SELECT COUNT(*) AS cnt FROM vendas WHERE caixa_sessao_id = ? AND status = 'cancelada'
  `).get(sid);

  const ts = db.prepare(`
    SELECT COALESCE(SUM(valor), 0) AS total FROM sangrias WHERE caixa_sessao_id = ?
  `).get(sid);

  const sessaoInfo = db.prepare(`SELECT * FROM caixa_sessoes WHERE id = ?`).get(sid);
  const saldoEsperado = (sessaoInfo.valor_abertura || 0) + (t.d || 0) - (ts.total || 0);

  db.prepare(`
    UPDATE caixa_sessoes SET
      fechamento_em    = datetime('now'),
      total_dinheiro   = ?,
      total_pix        = ?,
      total_debito     = ?,
      total_credito    = ?,
      total_convenio   = ?,
      total_outros     = ?,
      total_vendas     = ?,
      total_canceladas = ?,
      total_sangrias   = ?,
      status           = 'fechado'
    WHERE id = ?
  `).run(t.d, t.pi, t.de, t.cr, t.co, t.ou, t.tv, tc.cnt, ts.total, sid);

  const resultado = db.prepare(`SELECT * FROM caixa_sessoes WHERE id = ?`).get(sid);
  sessao.caixa_sessao_id = null;
  logger.info(`Caixa fechado: sessao ${sid} — total R$ ${(t.d + t.pi + t.de + t.cr + t.co + t.ou).toFixed(2)}`);

  wsEnviar({
    event:   'pdv:caixa_fechado',
    payload: {
      loja_id:      parseInt(cfg('loja_id') || '1'),
      numero_pdv:   cfg('numero_pdv') || '01',
      total_vendas: t.d + t.pi + t.de + t.cr + t.co + t.ou,
    },
  });

  // Tenta sincronizar o caixa fechado para o servidor (silencioso se offline)
  try { await syncCaixaUnica(sid); } catch { /* offline — sync.js tentará depois */ }

  return { sucesso: true, sessao: resultado };
});

// ═══════════════════════════════════════════════════════════════════════════════
// SANGRIA
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('sangria:registrar', (_e, { valor, motivo }) => {
  if (!sessao?.caixa_sessao_id) return { sucesso: false, mensagem: 'Nenhum caixa aberto.' };
  if (!(valor > 0)) return { sucesso: false, mensagem: 'Valor inválido.' };

  db.prepare(`
    INSERT INTO sangrias (caixa_sessao_id, usuario_id, valor, motivo, data_hora)
    VALUES (?,?,?,?, datetime('now'))
  `).run(sessao.caixa_sessao_id, sessao.usuario.id, valor, motivo || '');

  logger.info(`Sangria R$ ${valor} — sessao ${sessao.caixa_sessao_id}`);
  return { sucesso: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUTOS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('produto:buscar', (_e, { termo }) => {
  if (!termo) return { encontrado: false };
  termo = String(termo).trim();

  // Por código de barras
  const cb = db.prepare(`
    SELECT p.id, p.nome, p.unidade_base, p.fator_embalagem,
           pcb.codigo_barras, pcb.tipo_embalagem,
           pcb.preco_venda AS preco_embalagem
    FROM produtos_codigos_barras pcb
    JOIN produtos p ON p.id = pcb.produto_id
    WHERE pcb.codigo_barras = ? AND p.bloqueado = 0
    LIMIT 1
  `).get(termo);
  if (cb) return { encontrado: true, produto: cb, origem: 'barcode' };

  // Por código interno alternativo
  const num = parseInt(termo);
  if (num > 0) {
    const ca = db.prepare(`
      SELECT * FROM produtos WHERE codigo_interno_alternativo = ? AND bloqueado = 0 LIMIT 1
    `).get(num);
    if (ca) {
      const cbAlt = db.prepare(`
        SELECT * FROM produtos_codigos_barras WHERE produto_id = ? AND tipo_embalagem = 'UN' LIMIT 1
      `).get(ca.id) || db.prepare(`
        SELECT * FROM produtos_codigos_barras WHERE produto_id = ? LIMIT 1
      `).get(ca.id);
      return {
        encontrado: true,
        produto: {
          ...ca,
          tipo_embalagem:  cbAlt?.tipo_embalagem || 'UN',
          codigo_barras:   cbAlt?.codigo_barras  || '',
          preco_embalagem: cbAlt?.preco_venda    || ca.preco_venda,
        },
        origem: 'codigo_alternativo',
      };
    }
  }
  return { encontrado: false };
});

ipcMain.handle('produto:pesquisar', (_e, { busca }) => {
  if (!busca?.trim()) return [];
  const like = '%' + busca.trim() + '%';
  return db.prepare(`
    SELECT p.id, p.nome, p.preco_venda, p.unidade_base, p.fator_embalagem,
           p.codigo_interno_alternativo,
           (SELECT GROUP_CONCAT(tipo_embalagem||':'||codigo_barras, '|')
            FROM produtos_codigos_barras WHERE produto_id = p.id) AS codigos
    FROM produtos p
    WHERE p.bloqueado = 0
      AND (p.nome LIKE ? OR CAST(p.codigo_interno_alternativo AS TEXT) LIKE ?)
    ORDER BY p.nome
    LIMIT 30
  `).all(like, like);
});

// ═══════════════════════════════════════════════════════════════════════════════
// VENDAS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('venda:criar', () => {
  if (!sessao) return { sucesso: false, mensagem: 'Não logado.' };
  const num  = gerarNumeroVenda();
  const info = db.prepare(`
    INSERT INTO vendas (numero_venda, caixa_sessao_id, usuario_id, data_venda, status)
    VALUES (?, ?, ?, datetime('now'), 'aberta')
  `).run(num, sessao.caixa_sessao_id || null, sessao.usuario.id);
  return { sucesso: true, venda_id: info.lastInsertRowid, numero_venda: num };
});

ipcMain.handle('venda:cancelar', (_e, { venda_id }) => {
  const pgto = db.prepare(`
    SELECT id FROM pagamentos_venda WHERE venda_id = ? AND status = 'confirmado' LIMIT 1
  `).get(venda_id);
  if (pgto) return { sucesso: false, mensagem: 'Venda com pagamento confirmado não pode ser cancelada.' };

  db.prepare(`UPDATE vendas SET status = 'cancelada' WHERE id = ?`).run(venda_id);
  return { sucesso: true };
});

ipcMain.handle('venda:atualizar', (_e, data) => {
  const { venda_id, ...campos } = data;
  const permitidos = ['desconto', 'acrescimo', 'cliente_cpf', 'cliente_nome', 'cliente_id', 'observacao'];
  const set = []; const vals = [];
  for (const k of permitidos) {
    if (campos[k] !== undefined) { set.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (!set.length) return { sucesso: false };
  vals.push(venda_id);
  db.prepare(`UPDATE vendas SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  return { sucesso: true };
});

ipcMain.handle('venda:finalizar', async (_e, { venda_id, itens, desconto, acrescimo }) => {
  try {
    if (!Array.isArray(itens) || itens.length === 0) {
      return { sucesso: false, mensagem: 'A venda precisa ter ao menos um item.' };
    }

    for (const [i, item] of itens.entries()) {
      if (!item.produto_id || item.produto_id <= 0) {
        return { sucesso: false, mensagem: `Item #${i + 1}: produto inválido.` };
      }
      if (!item.quantidade || item.quantidade <= 0) {
        return { sucesso: false, mensagem: `Item #${i + 1}: quantidade deve ser maior que zero.` };
      }
    }

    const subtotal = itens.reduce(
      (s, i) => s + (i.valor_unitario * i.quantidade) - (i.desconto_item || 0),
      0
    );

    const desc = parseFloat(desconto)  || 0;
    const acr  = parseFloat(acrescimo) || 0;

    if (desc < 0) {
      return { sucesso: false, mensagem: 'Desconto não pode ser negativo.' };
    }
    if (desc > subtotal + acr) {
      return { sucesso: false, mensagem: `Desconto (R$ ${desc.toFixed(2)}) maior que o valor da venda.` };
    }

    const total = Math.max(0, subtotal - desc + acr);

    if (total <= 0) {
      return { sucesso: false, mensagem: 'O total da venda não pode ser zero ou negativo.' };
    }

    // Transação: grava venda + itens no SQLite local
    const finOp = db.transaction(() => {
      db.prepare(`
        UPDATE vendas
        SET subtotal = ?, desconto = ?, acrescimo = ?, total = ?, status = 'finalizada'
        WHERE id = ?
      `).run(subtotal, desc, acr, total, venda_id);

      db.prepare(`DELETE FROM venda_itens WHERE venda_id = ?`).run(venda_id);

      const ins = db.prepare(`
        INSERT INTO venda_itens
          (venda_id, produto_id, produto_nome, quantidade, valor_unitario,
           desconto_item, subtotal, codigo_barras_usado, unidade_origem)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);

      for (const i of itens) {
        const subtotalItem = (i.valor_unitario * i.quantidade) - (i.desconto_item || 0);
        ins.run(
          venda_id, i.produto_id, i.produto_nome, i.quantidade, i.valor_unitario,
          i.desconto_item || 0, subtotalItem,
          i.codigo_barras_usado || '', i.unidade_origem || 'UN'
        );
      }

      return { subtotal, total };
    });

    const result = finOp();
    logger.info(`Venda #${venda_id} finalizada — total R$ ${result.total.toFixed(2)}`);

    // Notifica servidor via WebSocket
    const vendaInfo = db.prepare('SELECT numero_venda FROM vendas WHERE id = ?').get(venda_id);
    wsEnviar({
      event:   'pdv:venda_finalizada',
      payload: {
        venda_id,
        total:        result.total,
        numero_venda: vendaInfo?.numero_venda || '',
      },
    });

    // Tenta sync imediato (silencioso se offline — sync.js tentará depois)
    try { await syncVendaUnica(venda_id); } catch { /* offline ou erro de rede */ }

    return { sucesso: true, ...result };

  } catch (err) {
    logger.error('venda:finalizar: ' + err.message);
    return { sucesso: false, mensagem: 'Erro ao finalizar.' };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGAMENTOS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('pagamento:registrar', (_e, { venda_id, tipo_pagamento, valor, referencia_externa }) => {
  if (!(valor > 0)) return { sucesso: false, mensagem: 'Valor inválido.' };

  const tiposValidos = ['pix', 'convenio', 'pos_debito', 'pos_credito', 'pos_pix', 'dinheiro', 'outros'];
  if (!tiposValidos.includes(tipo_pagamento)) {
    return { sucesso: false, mensagem: 'Tipo de pagamento inválido.' };
  }

  const info = db.prepare(`
    INSERT INTO pagamentos_venda (venda_id, tipo_pagamento, valor, referencia_externa, status, data_hora)
    VALUES (?,?,?,?, 'confirmado', datetime('now'))
  `).run(venda_id, tipo_pagamento, valor, referencia_externa || null);

  return { sucesso: true, id: info.lastInsertRowid };
});

ipcMain.handle('pagamento:listar', (_e, { venda_id }) => {
  return db.prepare(`SELECT * FROM pagamentos_venda WHERE venda_id = ? ORDER BY id`).all(venda_id);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGAR.ME — PIX (chamadas ao servidor, token auth)
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('pagarme:criarPix', async (_e, { venda_id, valor, numero_venda, cliente_nome, cliente_cpf, cliente_email }) => {
  const token       = cfg('api_token');
  const servidorUrl = cfg('servidor_url');
  const lojaId      = parseInt(cfg('loja_id') || '1');
  const numeroPdv   = cfg('numero_pdv') || '01';

  // ── LOG DE ENTRADA ──────────────────────────────────────────────────────────
  logger.info('[PIX IPC] ══════════════════════════════════════');
  logger.info('[PIX IPC] pagarme:criarPix CHAMADO', {
    venda_id,
    valor,
    numero_venda: numero_venda || '(vazio)',
    cliente_nome: cliente_nome || '(vazio)',
    cliente_cpf:  cliente_cpf  || '(vazio)',
    token_configurado:  !!token,
    token_primeiros4:   token ? token.slice(0, 4) + '...' : 'NÃO CONFIGURADO',
    servidor_url:       servidorUrl || 'NÃO CONFIGURADO',
    loja_id:            lojaId,
    numero_pdv:         numeroPdv,
  });

  // Validações
  if (!token) {
    const msg = 'api_token não está configurado no banco local. Acesse Configurações do PDV.';
    logger.error('[PIX IPC] ABORTADO —', msg);
    return { sucesso: false, mensagem: msg };
  }
  if (!servidorUrl) {
    const msg = 'servidor_url não está configurado no banco local. Acesse Configurações do PDV.';
    logger.error('[PIX IPC] ABORTADO —', msg);
    return { sucesso: false, mensagem: msg };
  }
  if (!valor || valor <= 0) {
    const msg = 'Valor inválido: ' + valor;
    logger.error('[PIX IPC] ABORTADO —', msg);
    return { sucesso: false, mensagem: msg };
  }
  if (!venda_id) {
    const msg = 'venda_id não informado';
    logger.error('[PIX IPC] ABORTADO —', msg);
    return { sucesso: false, mensagem: msg };
  }

  const url = `${servidorUrl}/api/pdv/pix/criar`;
  const requestBody = {
    venda_id,
    valor,
    loja_id:      lojaId,
    numero_pdv:   numeroPdv,
    numero_venda: numero_venda  || '',
    cliente_nome: cliente_nome  || '',
    cliente_cpf:  cliente_cpf   || '',
    cliente_email: cliente_email || '',
  };

  logger.info('[PIX IPC] POST →', url);
  logger.info('[PIX IPC] Request body:', JSON.stringify(requestBody));

  try {
    const resp = await axios.post(url, requestBody, axiosOpts({
      params:  { token },
      timeout: 20_000,
      headers: { 'Content-Type': 'application/json' },
    }));

    logger.info('[PIX IPC] HTTP Status:', resp.status);
    logger.info('[PIX IPC] Response data.status:', resp.data?.status);
    logger.info('[PIX IPC] Response data.data keys:', Object.keys(resp.data?.data || {}).join(', ') || '(vazio)');
    logger.info('[PIX IPC] order_id:', resp.data?.data?.order_id || '(ausente)');
    logger.info('[PIX IPC] charge_id:', resp.data?.data?.charge_id || '(ausente)');
    logger.info('[PIX IPC] qr_code presente:', !!(resp.data?.data?.qr_code));
    logger.info('[PIX IPC] qr_code_url presente:', !!(resp.data?.data?.qr_code_url));
    logger.info('[PIX IPC] expires_in:', resp.data?.data?.expires_in || '(ausente)');

    if (resp.data.status !== 'success') {
      const msg = resp.data.message || resp.data.mensagem || 'Servidor retornou status != success';
      logger.error('[PIX IPC] Servidor retornou ERRO:', msg);
      logger.error('[PIX IPC] Response completo:', JSON.stringify(resp.data).slice(0, 1000));
      return { sucesso: false, mensagem: msg };
    }

    const d = resp.data.data || {};
    logger.info('[PIX IPC] ✓ PIX criado com sucesso! order_id:', d.order_id);

    // Salva mapeamento venda → PDV no cache local para o WS rotear depois
    if (numero_venda) {
      const chaveVendaPdv = `venda_pdv:${numero_venda}`;
      try {
        db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)')
          .run(chaveVendaPdv, `${lojaId}:${numeroPdv}`);
        logger.info('[PIX IPC] Mapeamento salvo localmente:', chaveVendaPdv, '→', `${lojaId}:${numeroPdv}`);
      } catch (e) {
        logger.warn('[PIX IPC] Falha ao salvar mapeamento local (não crítico):', e.message);
      }
    }

    return { sucesso: true, ...d };

  } catch (err) {
    const httpStatus  = err.response?.status ?? null;
    const serverMsg   = err.response?.data?.message
                     || err.response?.data?.mensagem
                     || null;
    const mensagem    = serverMsg || err.message || 'Erro de conexão com o servidor.';

    logger.error('[PIX IPC] ✗ EXCEÇÃO ao chamar API PIX', {
      url,
      http_status:   httpStatus,
      mensagem,
      err_code:      err.code || null,
      response_body: err.response?.data
                       ? JSON.stringify(err.response.data).slice(0, 800)
                       : null,
    });

    // Mensagem amigável para o operador
    let msgAmigavel = mensagem;
    if (!httpStatus) {
      msgAmigavel = `Sem resposta do servidor (${err.code || 'timeout'}). Verifique a conexão e o servidor_url nas configurações.`;
    } else if (httpStatus === 401 || httpStatus === 403) {
      msgAmigavel = `Token inválido ou sem permissão (HTTP ${httpStatus}). Verifique o api_token nas configurações.`;
    } else if (httpStatus === 422) {
      msgAmigavel = `Dados inválidos para a Pagar.me (HTTP 422): ${mensagem}`;
    } else if (httpStatus >= 500) {
      msgAmigavel = `Erro interno no servidor (HTTP ${httpStatus}): ${mensagem}`;
    }

    return { sucesso: false, mensagem: `${msgAmigavel}` };
  }
});

ipcMain.handle('pagarme:cancelarPix', async (_e, { order_id }) => {
  const token       = cfg('api_token');
  const servidorUrl = cfg('servidor_url');

  if (!token || !servidorUrl) return { sucesso: false, mensagem: 'Servidor não configurado.' };

  try {
    const resp = await axios.post(
      `${servidorUrl}/api/pdv/pix/cancelar`,
      { order_id },
      axiosOpts({
        params:  { token },
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    return { sucesso: resp.data.status === 'success' };
  } catch (err) {
    logger.warn('pagarme:cancelarPix: ' + (err.message || 'Erro'));
    return { sucesso: false, mensagem: err.message };
  }
});

ipcMain.handle('pagarme:statusPix', async (_e, { order_id }) => {
  const token       = cfg('api_token');
  const servidorUrl = cfg('servidor_url');

  if (!token || !servidorUrl) return null;

  try {
    const resp = await axios.get(
      `${servidorUrl}/api/pdv/pix/status`,
      axiosOpts({ params: { token, order_id }, timeout: 8_000 })
    );
    return resp.data.status === 'success' ? resp.data.data : null;
  } catch {
    return null;
  }
});

const PERM_MAP = {
  desconto_item:  'permite_desconto_item',
  desconto_venda: 'permite_desconto_venda',
  cancelar_item:  'permite_cancelar_item',
  cancelar_venda: 'permite_cancelar_venda',
};

ipcMain.handle('supervisor:validarCartao', (_e, { codigo, acao }) => {
  const c = db.prepare(`
    SELECT sc.*, u.nome AS supervisor_nome
    FROM supervisores_cartoes sc
    JOIN usuarios u ON u.id = sc.usuario_id
    WHERE sc.codigo_cartao = ? AND sc.ativo = 1
  `).get(codigo);

  if (!c) return { valido: false, mensagem: 'Cartão não encontrado.' };

  const campo = PERM_MAP[acao];
  if (campo && !c[campo]) return { valido: false, mensagem: 'Cartão sem permissão para esta ação.' };

  return { valido: true, nome: c.supervisor_nome, tipo: 'cartao' };
});

ipcMain.handle('supervisor:validarLogin', async (_e, { login, senha, acao }) => {
  const u = db.prepare(`
    SELECT * FROM usuarios
    WHERE login = ? AND status = 'ativado' AND perfil IN ('gerente','administrador')
  `).get(login);

  if (!u) return { valido: false, mensagem: 'Supervisor não encontrado ou sem permissão.' };

  if (u.password_local) {
    const ok = await bcrypt.compare(senha, u.password_local);
    if (!ok) return { valido: false, mensagem: 'Senha incorreta.' };
  } else {
    return { valido: false, mensagem: 'Supervisor precisa ter feito login online ao menos uma vez.' };
  }

  return { valido: true, nome: u.nome, tipo: 'login' };
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTE
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('cliente:buscarCpf', (_e, { cpf }) => {
  const limpo = String(cpf).replace(/\D/g, '');
  return db.prepare(`SELECT * FROM clientes WHERE cpf = ? AND status = 'ativo'`).get(limpo) || null;
});

// ═══════════════════════════════════════════════════════════════════════════════
// SISTEMA
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('sistema:status', () => ({
  online:       isOnline,
  versao:       cfg('versao')       || '3.0.0',
  numero_pdv:   cfg('numero_pdv')   || '01',
  loja_id:      cfg('loja_id')      || '1',
  servidor_url: cfg('servidor_url') || '',
  ws_url:       cfg('ws_url')       || '',
  ws_conectado: wsAutenticado,
  ultima_sync:  cfg('ultima_sincronizacao') || 'Nunca',
}));

// Lê/grava configuração pelo renderer
ipcMain.handle('config:get', (_e, chave) => cfg(chave));
ipcMain.handle('config:set', (_e, { chave, valor }) => {
  db.prepare('INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)').run(chave, String(valor));
  return { sucesso: true };
});

// Status da conexão WebSocket
ipcMain.handle('ws:status', () => ({
  conectado:   wsClient?.readyState === (WebSocket?.OPEN ?? 1),
  autenticado: wsAutenticado,
}));

async function executarCargaInicial() {
  if (!isOnline) return { sucesso: false, mensagem: 'Sem conexão com o servidor.' };

  const token = cfg('api_token');
  if (!token) {
    return { sucesso: false, mensagem: 'api_token não configurado.' };
  }

  const lojaId = cfg('loja_id') || null;

  try {
    const base   = cfg('servidor_url');
    const params = { token };
    if (lojaId) params.loja_id = lojaId;

    const resp = await axios.get(base + '/api/carga-inicial', axiosOpts({
      params,
      timeout: 15000,
    }));

    if (resp.data.status !== 'success') {
      throw new Error(resp.data.message || 'Erro no servidor.');
    }

    const { produtos, codigos_barras, usuarios, supervisores_cartoes, clientes } = resp.data.data;

    const load = db.transaction(() => {
      const insProd = db.prepare(`
        INSERT OR REPLACE INTO produtos
          (id, nome, codigo_interno_alternativo, preco_venda, fator_embalagem, unidade_base, bloqueado, atualizado_em)
        VALUES (?,?,?,?,?,?,?, datetime('now'))
      `);
      for (const p of (produtos || [])) {
        insProd.run(p.id, p.nome, p.codigo_interno_alternativo || null, p.preco_venda, p.fator_embalagem, p.unidade_base, p.bloqueado || 0);
      }

      if ((codigos_barras || []).length > 0) {
        const prodIds = [...new Set(codigos_barras.map(c => c.produto_id))];
        const delCb   = db.prepare(`DELETE FROM produtos_codigos_barras WHERE produto_id = ?`);
        for (const pid of prodIds) delCb.run(pid);

        const insCb = db.prepare(`
          INSERT OR REPLACE INTO produtos_codigos_barras (produto_id, tipo_embalagem, codigo_barras, preco_venda)
          VALUES (?,?,?,?)
        `);
        for (const cb of codigos_barras) {
          insCb.run(cb.produto_id, cb.tipo_embalagem, cb.codigo_barras, cb.preco_venda);
        }
      }

      const insUser = db.prepare(`
        INSERT OR REPLACE INTO usuarios
          (id, login, password_local, perfil, nome, cpf, status, atualizado_em)
        VALUES (?,?,?,?,?,?,?, datetime('now'))
      `);
      for (const u of (usuarios || [])) {
        const existente = db.prepare(`SELECT password_local FROM usuarios WHERE id = ?`).get(u.id);
        insUser.run(u.id, u.login, existente?.password_local || null, u.perfil, u.nome, u.cpf || null, u.status);
      }

      const insSup = db.prepare(`
        INSERT OR REPLACE INTO supervisores_cartoes
          (id, usuario_id, codigo_cartao, descricao,
           permite_desconto_item, permite_desconto_venda,
           permite_cancelar_item, permite_cancelar_venda, ativo)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      for (const s of (supervisores_cartoes || [])) {
        insSup.run(s.id, s.usuario_id, s.codigo_cartao, s.descricao || null,
          s.permite_desconto_item || 0, s.permite_desconto_venda || 0,
          s.permite_cancelar_item || 0, s.permite_cancelar_venda || 0, s.ativo || 1);
      }

      const insCli = db.prepare(`
        INSERT OR REPLACE INTO clientes (id, nome, cpf, telefone, status)
        VALUES (?,?,?,?,?)
      `);
      for (const c of (clientes || [])) {
        insCli.run(c.id, c.nome, c.cpf || null, c.telefone || null, c.status || 'ativo');
      }
    });

    load();
    db.prepare(`UPDATE config SET valor = datetime('now') WHERE chave = 'ultima_sincronizacao'`).run();
    logger.info(`Carga inicial: ${produtos?.length || 0} produtos, ${codigos_barras?.length || 0} códigos, ${usuarios?.length || 0} usuários`);

    return {
      sucesso: true,
      totais: {
        produtos:       produtos?.length || 0,
        codigos_barras: codigos_barras?.length || 0,
        usuarios:       usuarios?.length || 0,
        cartoes:        supervisores_cartoes?.length || 0,
        clientes:       clientes?.length || 0,
      },
    };

  } catch (err) {
    logger.error('cargaInicial falhou: ' + err.message, {
      status: err.response?.status ?? null,
      body:   err.response?.data   ?? null,
      url:    err.config?.url      ?? null,
    });
    return { sucesso: false, mensagem: err.message };
  }
}

ipcMain.handle('sistema:cargaInicial', () => executarCargaInicial());

// ═══════════════════════════════════════════════════════════════════════════════
// CANCELAMENTOS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('cancelamento:registrar', (_e, { tipo, venda_id, item_id, motivo, valor, supervisor_id }) => {
  try {
    if (!['venda', 'item'].includes(tipo)) return { sucesso: false, mensagem: 'Tipo inválido.' };

    // Cancela a venda/item localmente
    if (tipo === 'venda') {
      db.prepare(`UPDATE vendas SET status = 'cancelada' WHERE id = ? AND status != 'cancelada'`).run(venda_id);
    } else if (tipo === 'item' && item_id) {
      db.prepare(`DELETE FROM venda_itens WHERE id = ? AND venda_id = ?`).run(item_id, venda_id);
    }

    const info = db.prepare(`
      INSERT INTO cancelamentos (tipo, venda_id, item_id, motivo, valor, supervisor_id, cancelado_em)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(tipo, venda_id, item_id || null, motivo || '', valor || 0, supervisor_id || null);

    logger.info(`Cancelamento: ${tipo} #${venda_id} — motivo: ${motivo}`);
    return { sucesso: true, id: info.lastInsertRowid };
  } catch (err) {
    logger.error('cancelamento:registrar: ' + err.message);
    return { sucesso: false, mensagem: err.message };
  }
});

ipcMain.handle('cancelamento:listar', (_e, { caixa_sessao_id } = {}) => {
  if (caixa_sessao_id) {
    return db.prepare(`
      SELECT c.*, v.numero_venda FROM cancelamentos c
      LEFT JOIN vendas v ON v.id = c.venda_id
      WHERE v.caixa_sessao_id = ?
      ORDER BY c.cancelado_em DESC
    `).all(caixa_sessao_id);
  }
  return db.prepare(`
    SELECT c.*, v.numero_venda FROM cancelamentos c
    LEFT JOIN vendas v ON v.id = c.venda_id
    ORDER BY c.cancelado_em DESC LIMIT 100
  `).all();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC — endpoint dedicado com token (sem sessão PHP)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * syncVendaUnica — envia uma venda finalizada para o servidor via
 * POST /api/pdv/sync-venda?token=XXX
 *
 * ─ Não depende de sessão PHP (token estático igual à carga inicial).
 * ─ Idempotente: reenvios do mesmo numero_venda não duplicam dados.
 * ─ Envia venda + itens + pagamentos em uma única requisição atômica.
 * ─ O servidor cuida da baixa de estoque e do status 'finalizada'.
 *
 * @param {number} venda_id  ID local (SQLite) da venda
 */
async function syncVendaUnica(venda_id) {
  const token      = cfg('api_token');
  const servidorUrl = cfg('servidor_url');

  if (!token)       throw new Error('api_token não configurado no config local.');
  if (!servidorUrl) throw new Error('servidor_url não configurado no config local.');

  // Só sincroniza vendas finalizadas e não sincronizadas
  const venda = db.prepare(`
    SELECT * FROM vendas WHERE id = ? AND sincronizado = 0 AND status = 'finalizada'
  `).get(venda_id);

  if (!venda) return; // já sincronizada ou não finalizada — nada a fazer

  const itens = db.prepare(`
    SELECT produto_id, produto_nome, quantidade, valor_unitario,
           desconto_item, subtotal, codigo_barras_usado, unidade_origem
    FROM venda_itens WHERE venda_id = ?
  `).all(venda_id);

  const pagamentos = db.prepare(`
    SELECT tipo_pagamento, valor, referencia_externa
    FROM pagamentos_venda WHERE venda_id = ?
  `).all(venda_id);

  const payload = {
    numero_venda:  venda.numero_venda,
    loja_id:       parseInt(cfg('loja_id') || '1'),
    numero_pdv:    cfg('numero_pdv') || '01',
    usuario_id:    venda.usuario_id,
    cliente_id:    venda.cliente_id    || null,
    cliente_cpf:   venda.cliente_cpf   || null,
    cliente_nome:  venda.cliente_nome  || 'CONSUMIDOR FINAL',
    subtotal:      venda.subtotal      || 0,
    desconto:      venda.desconto      || 0,
    acrescimo:     venda.acrescimo     || 0,
    total:         venda.total,
    data_venda:    venda.data_venda,
    observacao:    venda.observacao    || null,
    itens,
    pagamentos,
  };

  try {
    const resp = await axios.post(
      `${servidorUrl}/api/pdv/sync-venda`,
      payload,
      axiosOpts({
        params:  { token },
        timeout: 12_000,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    if (resp.data.status !== 'success') {
      throw new Error(resp.data.message || 'Resposta inesperada do servidor.');
    }

    const idServidor = resp.data.data?.id_servidor ?? null;

    // Marca como sincronizado no SQLite local
    db.prepare(`
      UPDATE vendas SET sincronizado = 1, id_servidor = ? WHERE id = ?
    `).run(idServidor, venda_id);

    db.prepare(`
      UPDATE pagamentos_venda SET sincronizado = 1 WHERE venda_id = ?
    `).run(venda_id);

    logger.info(`Venda local #${venda_id} → servidor #${idServidor}`);

  } catch (err) {
    // Re-lança para que sync.js possa registrar e interromper o loop
    logger.error('syncVendaUnica falhou: ' + err.message, {
      status: err.response?.status ?? null,
      url:    err.config?.url      ?? null,
      body:   err.response?.data   ?? null,
    });
    throw err;
  }
}

/**
 * syncCaixaUnica — envia uma sessão de caixa fechada para o servidor
 * POST /api/pdv/sync-caixa?token=XXX
 */
async function syncCaixaUnica(caixaId) {
  const token       = cfg('api_token');
  const servidorUrl = cfg('servidor_url');

  if (!token || !servidorUrl) return;

  const caixa = db.prepare(`SELECT * FROM caixa_sessoes WHERE id = ?`).get(caixaId);
  if (!caixa || caixa.status !== 'fechado') return;

  const sangrias = db.prepare(`
    SELECT usuario_id, valor, motivo, data_hora FROM sangrias WHERE caixa_sessao_id = ?
  `).all(caixaId);

  const numeroPdv = cfg('numero_pdv') || '01';

  // Calcula saldo esperado: abertura + dinheiro - sangrias
  const saldoEsperado = (caixa.valor_abertura || 0)
                       + (caixa.total_dinheiro || 0)
                       - (caixa.total_sangrias || 0);

  const payload = {
    loja_id:        parseInt(cfg('loja_id') || '1'),
    numero_pdv:      numeroPdv,
    operador_id:     caixa.usuario_id,
    usuario_id:      caixa.usuario_id,
    abertura_em:     caixa.abertura_em,
    fechamento_em:   caixa.fechamento_em,
    valor_abertura:  caixa.valor_abertura  || 0,
    total_dinheiro:  caixa.total_dinheiro  || 0,
    total_pix:       caixa.total_pix       || 0,
    total_debito:    caixa.total_debito    || 0,
    total_credito:   caixa.total_credito   || 0,
    total_convenio:  caixa.total_convenio  || 0,
    total_outros:    caixa.total_outros    || 0,
    total_vendas:    caixa.total_vendas    || 0,
    total_canceladas: caixa.total_canceladas || 0,
    total_sangrias:  caixa.total_sangrias  || 0,
    saldo_esperado:  saldoEsperado,
    caixa_contado:   null,
    diferenca:       null,
    status:          caixa.status,
    sangrias,
  };

  try {
    const resp = await axios.post(
      `${servidorUrl}/api/pdv/sync-caixa`,
      payload,
      axiosOpts({
        params:  { token },
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    if (resp.data.status === 'success') {
      logger.info(`Caixa local #${caixaId} → servidor #${resp.data.data?.id_servidor}`);
    } else {
      throw new Error(resp.data.message || 'Resposta inesperada.');
    }
  } catch (err) {
    logger.warn(`syncCaixaUnica falhou para caixa #${caixaId}: ${err.message}`);
    throw err;
  }
}

module.exports = { syncVendaUnica, syncCaixaUnica, syncCancelamentosOffline };

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC — CANCELAMENTOS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * syncCancelamentosOffline — envia cancelamentos pendentes ao servidor
 * POST /api/pdv/sync-cancelamento?token=XXX
 */
async function syncCancelamentosOffline() {
  const token       = cfg('api_token');
  const servidorUrl = cfg('servidor_url');
  if (!token || !servidorUrl) return;

  const pendentes = db.prepare(`
    SELECT c.*, v.numero_venda
    FROM cancelamentos c
    LEFT JOIN vendas v ON v.id = c.venda_id
    WHERE c.sincronizado = 0
    ORDER BY c.cancelado_em ASC
  `).all();

  if (!pendentes.length) return;

  const lojaId    = parseInt(cfg('loja_id') || '1');
  const numeroPdv = cfg('numero_pdv') || '01';

  const payload = {
    cancelamentos: pendentes.map(c => ({
      local_id:      c.id,                             // ID local SQLite — rastreia confirmação
      tipo:          c.tipo,
      venda_id:      c.venda_id,
      venda_item_id: c.item_id || null,                // item_id (local) → venda_item_id (servidor)
      loja_id:       lojaId,
      numero_pdv:    numeroPdv,
      usuario_id:    sessao?.usuario?.id || c.supervisor_id || 1,
      supervisor_id: c.supervisor_id || null,
      motivo:        c.motivo || '',
      valor:         c.valor  || 0,
      cancelado_em:  c.cancelado_em,
    })),
  };

  try {
    const resp = await axios.post(
      `${servidorUrl}/api/pdv/sync-cancelamento`,
      payload,
      axiosOpts({ params: { token }, timeout: 10_000, headers: { 'Content-Type': 'application/json' } })
    );

    if (resp.data.status === 'success') {
      // Marca APENAS os aceitos como sincronizados.
      // Os não sincronizados (venda ainda não subiu) serão tentados novamente.
      const aceitos = resp.data.data?.aceitos ?? null;

      if (aceitos === null) {
        // Servidor antigo sem suporte a aceitos[] — marca todos (fallback)
        const ids = pendentes.map(c => c.id);
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(`UPDATE cancelamentos SET sincronizado = 1 WHERE id IN (${ph})`).run(...ids);
        }
        logger.info(`syncCancelamentos: ${ids.length} cancelamento(s) sincronizados (modo legado).`);
      } else {
        // Marca apenas os IDs confirmados pelo servidor
        const ids = aceitos.filter(id => id != null).map(id => parseInt(id));
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(`UPDATE cancelamentos SET sincronizado = 1 WHERE id IN (${ph})`).run(...ids);
        }
        const pendentesRestantes = (resp.data.data?.nao_sincronizados ?? []).length;
        logger.info(`syncCancelamentos: ${ids.length} aceitos, ${pendentesRestantes} aguardando venda sincronizar.`);
      }
    }
  } catch (err) {
    logger.warn('syncCancelamentosOffline falhou: ' + err.message);
    throw err;
  }
}