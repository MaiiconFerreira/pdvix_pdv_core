// main.js — PDVix Electron
// Dependências: electron, better-sqlite3, bcryptjs, axios
const { app, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const { setupHttpLogger } = require('./httpLogger');
setupHttpLogger(); // ativa interceptors antes de qualquer requisição axios
const axios  = require('axios');
const bcrypt = require('bcryptjs');
const db     = require('./database');
const { logger } = require('./logger');

let mainWindow;
let sessao   = null;   // { usuario: {id, login, nome, perfil}, caixa_sessao_id }
let isOnline = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cfg(chave) {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return r ? r.valor : '';
}

async function verificarOnline() {
  try {
    await axios.get(cfg('servidor_url') + '/login', { timeout: 3000 });
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

  // Aguarda a janela carregar antes de disparar a carga — garante que o
  // renderer já está pronto para receber eventos se necessário
  mainWindow.webContents.once('did-finish-load', async () => {
    if (isOnline) {
      logger.info('Startup: iniciando carga inicial automática...');
      const resultado = await executarCargaInicial();
      if (resultado.sucesso) {
        logger.info(`Startup: carga inicial concluída — ${resultado.totais.produtos} produtos`);
      } else {
        logger.warn('Startup: carga inicial falhou — ' + resultado.mensagem);
      }
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

        const resp = await axios.post(url + '/auth', formData, {
          timeout: 6000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        if (resp.data.status === 'success') {
          const u    = resp.data.data.user;
          const hash = await bcrypt.hash(senha, 10);

          // Preserva perfil e senha local — upsert pelo id
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
  return { sucesso: true, id: info.lastInsertRowid };
});

ipcMain.handle('caixa:resumo', () => {
  if (!sessao?.caixa_sessao_id) return null;
  const sid = sessao.caixa_sessao_id;

  const totais = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'dinheiro'            THEN p.valor ELSE 0 END), 0) AS total_dinheiro,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento IN ('pix','pos_pix')    THEN p.valor ELSE 0 END), 0) AS total_pix,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'pos_debito'          THEN p.valor ELSE 0 END), 0) AS total_debito,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'pos_credito'         THEN p.valor ELSE 0 END), 0) AS total_credito,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'convenio'            THEN p.valor ELSE 0 END), 0) AS total_convenio,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'outros'              THEN p.valor ELSE 0 END), 0) AS total_outros,
      COALESCE(SUM(p.valor), 0)   AS total_geral,
      COUNT(DISTINCT v.id)        AS total_vendas
    FROM vendas v
    LEFT JOIN pagamentos_venda p ON p.venda_id = v.id AND p.status = 'confirmado'
    WHERE v.caixa_sessao_id = ? AND v.status = 'finalizada'
  `).get(sid);

  const canceladas = db.prepare(`
    SELECT COUNT(*) AS cnt FROM vendas WHERE caixa_sessao_id = ? AND status = 'cancelada'
  `).get(sid);

  const sangrias = db.prepare(`
    SELECT COALESCE(SUM(valor), 0) AS total FROM sangrias WHERE caixa_sessao_id = ?
  `).get(sid);

  const sessaoInfo = db.prepare(`SELECT * FROM caixa_sessoes WHERE id = ?`).get(sid);

  // Saldo esperado em caixa: abertura + dinheiro recebido - sangrias
  const saldo_caixa = (sessaoInfo.valor_abertura || 0)
                    + (totais.total_dinheiro || 0)
                    - (sangrias.total || 0);

  return {
    ...totais,
    total_canceladas: canceladas.cnt,
    total_sangrias:   sangrias.total,
    saldo_caixa,        // valor esperado em espécie na gaveta
    sessao:           sessaoInfo,
  };
});

ipcMain.handle('caixa:fechar', () => {
  if (!sessao?.caixa_sessao_id) return { sucesso: false, mensagem: 'Nenhum caixa aberto.' };
  const sid = sessao.caixa_sessao_id;

  // Bloqueia fechamento com venda em aberto
  const aberta = db.prepare(`
    SELECT id FROM vendas WHERE caixa_sessao_id = ? AND status = 'aberta'
  `).get(sid);
  if (aberta) return { sucesso: false, mensagem: 'Existe venda em andamento. Finalize ou cancele antes de fechar.' };

  // Calcula totais de pagamento por modalidade
  const t = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'dinheiro'         THEN p.valor ELSE 0 END), 0) AS d,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento IN ('pix','pos_pix') THEN p.valor ELSE 0 END), 0) AS pi,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'pos_debito'       THEN p.valor ELSE 0 END), 0) AS de,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'pos_credito'      THEN p.valor ELSE 0 END), 0) AS cr,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'convenio'         THEN p.valor ELSE 0 END), 0) AS co,
      COALESCE(SUM(CASE WHEN p.tipo_pagamento = 'outros'           THEN p.valor ELSE 0 END), 0) AS ou,
      COUNT(DISTINCT v.id) AS tv
    FROM vendas v
    LEFT JOIN pagamentos_venda p ON p.venda_id = v.id AND p.status = 'confirmado'
    WHERE v.caixa_sessao_id = ? AND v.status = 'finalizada'
  `).get(sid);

  const tc = db.prepare(`
    SELECT COUNT(*) AS cnt FROM vendas WHERE caixa_sessao_id = ? AND status = 'cancelada'
  `).get(sid);

  // Soma de sangrias
  const ts = db.prepare(`
    SELECT COALESCE(SUM(valor), 0) AS total FROM sangrias WHERE caixa_sessao_id = ?
  `).get(sid);

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
  logger.info(`Caixa fechado: sessao ${sid} — total vendas R$ ${t.d + t.pi + t.de + t.cr + t.co + t.ou}`);
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
    SELECT p.*, pcb.codigo_barras, pcb.tipo_embalagem, pcb.preco_venda AS preco_embalagem
    FROM produtos_codigos_barras pcb
    JOIN produtos p ON p.id = pcb.produto_id
    WHERE pcb.codigo_barras = ? AND p.bloqueado = 0
    LIMIT 1
  `).get(termo);
  if (cb) return { encontrado: true, produto: cb, origem: 'barcode' };

  // Por código alternativo
  const num = parseInt(termo);
  if (num > 0) {
    const ca = db.prepare(`
      SELECT * FROM produtos WHERE codigo_interno_alternativo = ? AND bloqueado = 0 LIMIT 1
    `).get(num);
    if (ca) {
      const cb2 = db.prepare(`
        SELECT * FROM produtos_codigos_barras WHERE produto_id = ? AND tipo_embalagem = 'UN' LIMIT 1
      `).get(ca.id)
        || db.prepare(`
        SELECT * FROM produtos_codigos_barras WHERE produto_id = ? LIMIT 1
      `).get(ca.id);
      return {
        encontrado: true,
        produto: {
          ...ca,
          tipo_embalagem:  cb2?.tipo_embalagem || 'UN',
          codigo_barras:   cb2?.codigo_barras  || '',
          preco_embalagem: cb2?.preco_venda    || ca.preco_venda,
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
  const num  = 'VND' + Date.now();
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
  if (pgto) return { sucesso: false, mensagem: 'Venda com pagamento já registrado não pode ser cancelada.' };

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
    // ── Validações de negócio ─────────────────────────────────────────────────
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
      if (item.valor_unitario < 0) {
        return { sucesso: false, mensagem: `Item #${i + 1}: valor unitário inválido.` };
      }
    }

    // Calcula subtotal considerando desconto por item
    const subtotal = itens.reduce(
      (s, i) => s + (i.valor_unitario * i.quantidade) - (i.desconto_item || 0),
      0
    );

    const desc = parseFloat(desconto) || 0;
    const acr  = parseFloat(acrescimo) || 0;

    // Desconto não pode ser maior que o subtotal
    if (desc < 0) {
      return { sucesso: false, mensagem: 'Desconto não pode ser negativo.' };
    }
    if (desc > subtotal + acr) {
      return { sucesso: false, mensagem: `Desconto (R$ ${desc.toFixed(2)}) não pode ser maior que o valor da venda (R$ ${(subtotal + acr).toFixed(2)}).` };
    }

    const total = Math.max(0, subtotal - desc + acr);

    // Venda com total zero não é permitida
    if (total <= 0) {
      return { sucesso: false, mensagem: 'O total da venda não pode ser zero ou negativo. Ajuste o desconto.' };
    }

    // ── Transação: grava venda, itens ──────────────────────────────────────
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

    // Tenta sync imediato com servidor (silencioso se falhar)
    try { await syncVendaUnica(venda_id); } catch { /* continua — sync.js tentará depois */ }

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
// SUPERVISOR
// ═══════════════════════════════════════════════════════════════════════════════

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
  versao:       cfg('versao')       || '2.0.0',
  numero_pdv:   cfg('numero_pdv')   || '01',
  servidor_url: cfg('servidor_url') || '',
  ultima_sync:  cfg('ultima_sincronizacao') || 'Nunca',
}));

/**
 * executarCargaInicial — lógica central da carga inicial.
 * Chamada automaticamente no startup (did-finish-load) e também via IPC
 * quando o renderer chamar pdv.cargaInicial() manualmente.
 */
async function executarCargaInicial() {
  if (!isOnline) return { sucesso: false, mensagem: 'Sem conexão com o servidor.' };

  const token = cfg('api_token');
  if (!token) {
    return { sucesso: false, mensagem: 'api_token não configurado. Configure config.api_token no SQLite local.' };
  }

  try {
    const base = cfg('servidor_url');
    const resp = await axios.get(base + '/api/carga-inicial', {
      params:  { token },
      timeout: 15000,
    });

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
        insProd.run(
          p.id, p.nome, p.codigo_interno_alternativo || null,
          p.preco_venda, p.fator_embalagem, p.unidade_base, p.bloqueado || 0
        );
      }

      if ((codigos_barras || []).length > 0) {
        const prodIds = [...new Set(codigos_barras.map(c => c.produto_id))];
        const delCb = db.prepare(`DELETE FROM produtos_codigos_barras WHERE produto_id = ?`);
        for (const pid of prodIds) delCb.run(pid);

        const insCb = db.prepare(`
          INSERT OR REPLACE INTO produtos_codigos_barras
            (produto_id, tipo_embalagem, codigo_barras, preco_venda)
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
        insSup.run(
          s.id, s.usuario_id, s.codigo_cartao, s.descricao || null,
          s.permite_desconto_item || 0, s.permite_desconto_venda || 0,
          s.permite_cancelar_item || 0, s.permite_cancelar_venda || 0,
          s.ativo || 1
        );
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

    logger.info(`Carga inicial concluída — ${produtos?.length || 0} produtos, ${codigos_barras?.length || 0} cód. barras, ${usuarios?.length || 0} usuários`);

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

// IPC — mantém compatibilidade com chamadas manuais do renderer (ex: DevTools)
ipcMain.handle('sistema:cargaInicial', () => executarCargaInicial());


// ═══════════════════════════════════════════════════════════════════════════════
// SYNC HELPER
// ═══════════════════════════════════════════════════════════════════════════════

async function syncVendaUnica(venda_id) {
  if (!isOnline) return;

  const venda = db.prepare(`SELECT * FROM vendas WHERE id = ? AND sincronizado = 0`).get(venda_id);
  if (!venda) return;

  const itens  = db.prepare(`SELECT * FROM venda_itens  WHERE venda_id = ?`).all(venda_id);
  const pagtos = db.prepare(`SELECT * FROM pagamentos_venda WHERE venda_id = ?`).all(venda_id);

  const base = cfg('servidor_url');

  // Monta payload de criação da venda no servidor
  const payload = {
    desconto:   venda.desconto,
    acrescimo:  venda.acrescimo,
    cliente_id: venda.cliente_id || null,
    observacao: venda.observacao || '',
    itens: itens.map(i => ({
      produto_id:     i.produto_id,
      quantidade:     i.quantidade,
      valor_unitario: i.valor_unitario,
    })),
  };

  try {
    // 1. Cria venda no servidor
    const respVenda = await axios.post(base + '/api/vendas', payload, { timeout: 10000 });
    if (respVenda.data.status !== 'success') throw new Error(respVenda.data.message);

    const servidorVendaId = respVenda.data.data.id;

    // 2. Registra cada pagamento
    for (const p of pagtos) {
      await axios.post(base + '/api/pagamentos', {
        venda_id:           servidorVendaId,
        tipo_pagamento:     p.tipo_pagamento,
        valor:              p.valor,
        status:             'confirmado',
        referencia_externa: p.referencia_externa || null,
      }, { timeout: 10000 });
    }

    // 3. Finaliza a venda no servidor
    await axios.post(base + '/api/vendas/finalizar', { id: servidorVendaId }, { timeout: 10000 });

    // 4. Marca como sincronizado no SQLite local
    db.prepare(`UPDATE vendas          SET sincronizado = 1, id_servidor = ? WHERE id = ?`).run(servidorVendaId, venda_id);
    db.prepare(`UPDATE pagamentos_venda SET sincronizado = 1 WHERE venda_id = ?`).run(venda_id);

    logger.info(`Venda local #${venda_id} → servidor #${servidorVendaId}`);

  } catch (err) {
    logger.error('syncVendaUnica falhou: ' + err.message, {
      status: err.response?.status ?? null,
      body:   err.response?.data   ?? null,
      url:    err.config?.url      ?? null,
    });
    throw err;
  }
}

module.exports = { syncVendaUnica };