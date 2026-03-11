// venda.js — PDVix Renderer v3 — Lógica do PDV
// ─────────────────────────────────────────────────────────────────────────────
// Atalhos:
//   F3       → Abrir venda
//   F2       → Finalizar venda (escolha de pagamento)
//   F4       → Informar CPF/nome do cliente
//   F6       → Desconto no total
//   F7       → Desconto no item selecionado
//   Delete   → Remover item selecionado
//   Escape   → Cancelar venda (ou fechar modal/PIX)
//
// Regra de pagamento: apenas 1 pagamento por vez.
// PIX: integração com Pagar.me — exibe QR Code na tela e aguarda confirmação.
// Comanda: itens recebidos via WS são carregados como venda normal.
// ─────────────────────────────────────────────────────────────────────────────

let estado = {
  vendaAberta:        false,
  vendaId:            null,
  itens:              [],
  subtotal:           0,
  descontoGeral:      0,
  total:              0,
  cpf:                'CONSUMIDOR FINAL',
  selectedIndex:      -1,
  modalAtivo:         null,
  quantidadePendente: 1,
  // Pagamento PIX em andamento
  pixAtivo:           false,
  pixOrderId:         null,
  pixTimer:           null,
  pixPollTimer:       null,
  // Pagamento POS / InfiniteTap em andamento
  posAtivo:           false,
  posOrderId:         null,
  posTipo:            null,
  posTimer:           null,
};

const dom = {
  inputCodigo: document.getElementById('codigo-barras'),
  tabela:      document.querySelector('#tabela-itens tbody'),
  subtotal:    document.getElementById('val-subtotal'),
  desconto:    document.getElementById('val-desconto'),
  total:       document.getElementById('val-total'),
  status:      document.getElementById('display-status'),
  cpf:         document.getElementById('display-cpf'),
  lastItem:    document.getElementById('display-last-item'),
  qtdPendente: document.getElementById('display-qtd-pendente'),
  modal:       document.getElementById('modal-container'),
  modalTitle:  document.getElementById('modal-title'),
  modalInput:  document.getElementById('modal-input'),
};

// ─── FUNÇÕES DE ESTADO ────────────────────────────────────────────────────────

async function abrirVenda() {
  if (estado.vendaAberta) return;

  const res = await window.pdv.vendaCriar();
  if (!res?.sucesso) {
    mostrarErro('Não foi possível abrir a venda: ' + (res?.mensagem || 'Erro desconhecido'));
    return;
  }

  estado = {
    ...estado,
    vendaAberta:        true,
    vendaId:            res.venda_id,
    numeroVenda:        res.numero_venda || '',   // armazena para uso no PIX
    itens:              [],
    subtotal:           0,
    descontoGeral:      0,
    total:              0,
    cpf:                'CONSUMIDOR FINAL',
    selectedIndex:      -1,
    quantidadePendente: 1,
    pixAtivo:           false,
    pixOrderId:         null,
  };

  dom.inputCodigo.disabled    = false;
  dom.inputCodigo.placeholder = 'Passe o scanner ou digite N* para quantidade...';
  dom.inputCodigo.focus();
  atualizarUI();
}

async function adicionarProduto(codigo) {
  if (!estado.vendaAberta) return;

  const result = await window.pdv.buscarCodigo({ termo: codigo });

  if (!result?.encontrado) {
    setLastItem(`⚠ Produto não encontrado: ${codigo}`, '#ff4d4d');
    return;
  }

  const p     = result.produto;
  const preco = parseFloat(p.preco_embalagem ?? p.preco_venda ?? 0);
  const qtd   = estado.quantidadePendente || 1;

  const existingIdx = estado.itens.findIndex(
    i => i.produto_id === p.id && i.codigo_barras_usado === (p.codigo_barras || '')
  );

  if (existingIdx >= 0) {
    estado.itens[existingIdx].quantidade += qtd;
    estado.selectedIndex = existingIdx;
  } else {
    estado.itens.push({
      produto_id:          p.id,
      produto_nome:        p.nome,
      preco,
      quantidade:          qtd,
      desconto_item:       0,
      codigo_barras_usado: p.codigo_barras  || '',
      unidade_origem:      p.tipo_embalagem || 'UN',
      valor_unitario:      preco,
      uid:                 Date.now(),
    });
    estado.selectedIndex = estado.itens.length - 1;
  }

  estado.quantidadePendente = 1;
  atualizarDisplayQtdPendente();
  setLastItem(`${p.nome}  ×${qtd}  — R$ ${preco.toFixed(2)}`);
  atualizarUI();
}

// ─── COMANDA — carrega itens como venda normal ────────────────────────────────

async function carregarComanda(payload) {
  // Normaliza estrutura: aceita tanto { numero, cliente_nome, itens }
  // quanto { tipo, payload: { numero, cliente_nome, itens } }.
  const dados = (payload && payload.payload) ? payload.payload : payload;
  const { numero, cliente_nome, itens } = dados;

  if (!estado.vendaAberta) {
    const res = await window.pdv.vendaCriar();
    if (!res?.sucesso) {
      mostrarErro('Comanda: não foi possível abrir a venda.');
      return;
    }
    estado.vendaAberta = true;
    estado.vendaId     = res.venda_id;
    estado.itens       = [];
    estado.descontoGeral = 0;
    dom.inputCodigo.disabled = false;
  }

  if (cliente_nome && cliente_nome !== 'CONSUMIDOR FINAL') {
    estado.cpf = cliente_nome;
    await window.pdv.vendaAtualizar({
      venda_id:     estado.vendaId,
      cliente_nome: cliente_nome,
    });
  }

  for (const item of (itens || [])) {
    if (!item.produto_id || !item.quantidade) continue;

    const preco = parseFloat(item.valor_unitario || 0);
    const qtd   = parseFloat(item.quantidade || 1);

    const existingIdx = estado.itens.findIndex(i => i.produto_id === item.produto_id);
    if (existingIdx >= 0) {
      estado.itens[existingIdx].quantidade += qtd;
    } else {
      estado.itens.push({
        produto_id:          item.produto_id,
        produto_nome:        item.produto_nome || `Produto #${item.produto_id}`,
        preco,
        quantidade:          qtd,
        desconto_item:       0,
        codigo_barras_usado: '',
        unidade_origem:      'UN',
        valor_unitario:      preco,
        uid:                 Date.now() + item.produto_id,
      });
    }
  }

  estado.selectedIndex = estado.itens.length > 0 ? 0 : -1;
  setLastItem(`✓ Comanda ${numero || ''} carregada — ${(itens||[]).length} item(ns)`, '#00f2ff');
  atualizarUI();
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function setLastItem(texto, cor = '') {
  dom.lastItem.innerText  = texto;
  dom.lastItem.style.color = cor;
}

function atualizarUI() {
  dom.tabela.innerHTML = '';
  estado.subtotal = 0;

  estado.itens.forEach((item, idx) => {
    const itemSubtotal = (item.preco * item.quantidade) - item.desconto_item;
    estado.subtotal   += (item.preco * item.quantidade);

    const tr = document.createElement('tr');
    if (idx === estado.selectedIndex) tr.className = 'selected';

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${item.produto_nome}</td>
      <td>${item.quantidade}</td>
      <td>R$ ${item.preco.toFixed(2)}</td>
      <td style="color:#ff4d4d">- R$ ${item.desconto_item.toFixed(2)}</td>
      <td>R$ ${itemSubtotal.toFixed(2)}</td>
    `;

    tr.addEventListener('click', () => {
      estado.selectedIndex = idx;
      atualizarUI();
    });

    dom.tabela.appendChild(tr);
    if (idx === estado.selectedIndex) tr.scrollIntoView({ block: 'nearest' });
  });

  const descontoItens = estado.itens.reduce((a, b) => a + b.desconto_item, 0);
  estado.total = Math.max(0, estado.subtotal - estado.descontoGeral - descontoItens);

  dom.subtotal.innerText = `R$ ${estado.subtotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  dom.desconto.innerText = `- R$ ${(estado.descontoGeral + descontoItens).toFixed(2)}`;
  dom.total.innerText    = `R$ ${estado.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  dom.status.innerText   = estado.vendaAberta ? 'VENDA EM ANDAMENTO' : 'CAIXA LIVRE';
  dom.status.style.borderColor = estado.vendaAberta ? '#00f2ff' : '#718096';
  dom.cpf.innerText      = estado.cpf;

  atualizarDisplayQtdPendente();
}

function atualizarDisplayQtdPendente() {
  if (!dom.qtdPendente) return;
  if (estado.quantidadePendente > 1) {
    dom.qtdPendente.innerText     = `QTD: ${estado.quantidadePendente}×`;
    dom.qtdPendente.style.display = 'inline-block';
    dom.qtdPendente.style.color   = '#f6c90e';
  } else {
    dom.qtdPendente.style.display = 'none';
  }
}

// ─── MODAIS ───────────────────────────────────────────────────────────────────

function mostrarModal(tipo, titulo, valorInicial = '') {
  estado.modalAtivo        = tipo;
  dom.modalTitle.innerText = titulo;
  dom.modalInput.value     = valorInicial;
  dom.modal.style.display  = 'flex';
  dom.modalInput.focus();
}

function fecharModal() {
  dom.modal.style.display = 'none';
  estado.modalAtivo       = null;
  dom.inputCodigo.focus();
}

function mostrarErro(msg) {
  console.error('[PDV][ERRO]', msg);
  setLastItem('⚠ ' + msg, '#ff4d4d');
}

// Erro crítico: exibe modal visível que o operador não pode ignorar.
// Usar quando o erro acontece num contexto onde setLastItem fica invisível
// (overlay PIX aberto, tela escurecida, etc.)
function mostrarErroCritico(titulo, detalhe) {
  console.error('[PDV][ERRO CRÍTICO]', titulo, detalhe || '');
  setLastItem('⚠ ' + titulo, '#ff4d4d');

  // Reusa o overlay do PIX (ou cria um novo) para garantir visibilidade
  let overlay = document.getElementById('pix-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pix-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;z-index:9999;';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:2px solid #ff4d4d;border-radius:16px;padding:32px;
                text-align:center;max-width:400px;width:92%;">
      <div style="color:#ff4d4d;font-size:1.4rem;font-weight:800;margin-bottom:10px;">&#9888; ${titulo}</div>
      ${detalhe ? `<div style="color:#f6c90e;font-size:0.9rem;margin:8px 0;word-break:break-word;">${detalhe}</div>` : ''}
      <div style="color:#888;font-size:0.78rem;margin-top:12px;">
        Abra o DevTools (Ctrl+Shift+I) &rarr; Console para detalhes técnicos.
      </div>
      <button id="erro-critico-ok" style="margin-top:20px;padding:10px 36px;background:#ff4d4d;
        color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:700;">
        OK
      </button>
    </div>
  `;
  overlay.style.display = 'flex';
  document.getElementById('erro-critico-ok').onclick = () => {
    overlay.style.display = 'none';
    dom.inputCodigo.focus();
  };
}

// ─── PIX — Modal QR Code ──────────────────────────────────────────────────────
// Cria dinamicamente um overlay de PIX com QR Code e countdown.


function criarOverlayPix() {
  let overlay = document.getElementById('pix-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pix-overlay';
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.85);
      display:flex; align-items:center; justify-content:center;
      z-index:9999; flex-direction:column; gap:16px;
    `;
    document.body.appendChild(overlay);
  }
  return overlay;
}

async function iniciarPagamentoPix() {
  console.log('[PIX] iniciarPagamentoPix() | vendaId:', estado.vendaId, '| total:', estado.total, '| itens:', estado.itens.length);

  if (!estado.vendaAberta || estado.itens.length === 0) {
    console.warn('[PIX] Abortado — venda não aberta ou sem itens.');
    return;
  }
  if (estado.pixAtivo) {
    mostrarErroCritico('PIX já em andamento', 'Cancele o PIX atual antes de iniciar outro.');
    return;
  }

  // Garante que não existe pagamento anterior para esta venda
  let pagamentosExistentes = [];
  try {
    pagamentosExistentes = await window.pdv.pagtoListar({ venda_id: estado.vendaId }) || [];
    console.log('[PIX] Pagamentos existentes:', pagamentosExistentes.length);
  } catch (e) {
    console.error('[PIX] Erro ao listar pagamentos:', e);
  }
  if (pagamentosExistentes.length > 0) {
    mostrarErroCritico('Pagamento já registrado', 'Cancele a venda e reabra para usar outro método.');
    return;
  }

  // Marca como ativo ANTES da chamada assíncrona para bloquear Escape
  estado.pixAtivo = true;

  // Exibe overlay "Gerando QR Code..."
  const overlay = criarOverlayPix();
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:2px solid #00f2ff;border-radius:16px;padding:32px;text-align:center;max-width:360px;width:90%;">
      <div style="color:#00f2ff;font-size:1.1rem;font-weight:700;margin-bottom:8px;">&#9889; PAGAMENTO PIX</div>
      <div id="pix-gerando-msg" style="color:#aaa;font-size:0.85rem;margin-bottom:16px;">Gerando QR Code...</div>
      <div id="pix-qr-area" style="min-height:200px;display:flex;align-items:center;justify-content:center;">
        <div style="color:#555;font-size:0.8rem;">Aguarde...</div>
      </div>
      <div id="pix-valor" style="color:#fff;font-size:1.4rem;font-weight:800;margin:12px 0;"></div>
      <div id="pix-countdown" style="color:#f6c90e;font-size:0.9rem;"></div>
      <div id="pix-status" style="margin-top:8px;font-size:0.85rem;color:#aaa;"></div>
      <button id="pix-cancelar-btn" style="
        margin-top:20px;padding:10px 28px;background:#ff4d4d;color:#fff;
        border:none;border-radius:8px;cursor:pointer;font-size:0.95rem;font-weight:600;
      ">Cancelar PIX</button>
    </div>
  `;
  overlay.style.display = 'flex';
  document.getElementById('pix-cancelar-btn').addEventListener('click', cancelarPix);

  // Chama a API do servidor
  const numeroVenda = await obterNumeroVenda();
  const clienteNome = estado.cpf !== 'CONSUMIDOR FINAL' ? estado.cpf : '';

  console.log('[PIX] Chamando pagarmeCriarPix:', { venda_id: estado.vendaId, valor: estado.total, numero_venda: numeroVenda });

  let res;
  try {
    res = await window.pdv.pagarmeCriarPix({
      venda_id:     estado.vendaId,
      valor:        estado.total,
      numero_venda: numeroVenda,
      cliente_nome: clienteNome,
    });
    console.log('[PIX] Resposta pagarmeCriarPix:', JSON.stringify(res));
  } catch (ipcErr) {
    // IPC lançou exceção — nunca deveria acontecer, mas protege
    estado.pixAtivo = false;
    console.error('[PIX] Exceção IPC:', ipcErr);
    mostrarErroCritico('Falha na comunicação interna (IPC)', String(ipcErr?.message || ipcErr));
    return;
  }

  // Resposta null/undefined
  if (!res) {
    estado.pixAtivo = false;
    console.error('[PIX] pagarmeCriarPix retornou null/undefined');
    mostrarErroCritico('Resposta inválida do servidor', 'O processo principal não retornou dados. Verifique o Console.');
    return;
  }

  // Servidor retornou erro
  if (!res.sucesso) {
    estado.pixAtivo = false;
    console.error('[PIX] sucesso=false:', res);
    mostrarErroCritico(
      'Erro ao gerar PIX',
      res.mensagem || 'Sem mensagem. Abra o Console (Ctrl+Shift+I) para detalhes.'
    );
    return;
  }

  // ── Sucesso — renderiza QR Code ──────────────────────────────────────────
  estado.pixOrderId = res.order_id;
  console.log('[PIX] Criado! order_id:', res.order_id, '| qr_code:', !!res.qr_code, '| qr_code_url:', !!res.qr_code_url);

  const gerMsg = document.getElementById('pix-gerando-msg');
  if (gerMsg) gerMsg.style.display = 'none';

  const qrArea = document.getElementById('pix-qr-area');
  if (res.qr_code_url) {
    console.log('[PIX] Renderizando QR via imagem URL');
    qrArea.innerHTML = `<img src="${res.qr_code_url}" style="width:200px;height:200px;border-radius:8px;" alt="QR Code PIX">`;
  } else if (res.qr_code) {
    console.log('[PIX] Renderizando QR via copia-e-cola (sem imagem URL)');
    qrArea.innerHTML = `
      <div>
        <div style="background:#fff;padding:8px;border-radius:8px;">
          <canvas id="pix-qr-canvas" width="200" height="200"></canvas>
        </div>
        <div style="color:#aaa;font-size:0.65rem;margin-top:6px;word-break:break-all;
                    max-width:220px;background:#111;padding:6px;border-radius:4px;">${res.qr_code}</div>
      </div>`;
    if (window.QRCode) {
      try { new window.QRCode(document.getElementById('pix-qr-canvas'), { text: res.qr_code, width: 200, height: 200 }); }
      catch (e) { console.warn('[PIX] QRCode render falhou:', e.message); }
    } else {
      console.warn('[PIX] window.QRCode não disponível — apenas copia-e-cola exibido.');
    }
  } else {
    console.warn('[PIX] Resposta sem qr_code e sem qr_code_url. res completo:', JSON.stringify(res));
    qrArea.innerHTML = `<div style="color:#f6c90e;font-size:0.8rem;padding:8px;">
      QR Code não retornado pela API.<br>Verifique as credenciais Pagar.me no servidor.
    </div>`;
  }

  document.getElementById('pix-valor').innerText = `R$ ${estado.total.toFixed(2).replace('.', ',')}`;

  // Countdown
  let segundosRestantes = res.expires_in || 600;
  const cdEl = document.getElementById('pix-countdown');
  estado.pixTimer = setInterval(() => {
    segundosRestantes--;
    if (segundosRestantes <= 0) {
      clearInterval(estado.pixTimer);
      cdEl.innerText = 'PIX expirado.';
      const stEl = document.getElementById('pix-status');
      if (stEl) { stEl.innerText = 'Cancele e tente novamente.'; stEl.style.color = '#ff4d4d'; }
      estado.pixAtivo = false;
      console.warn('[PIX] Expirado por timeout.');
      return;
    }
    const m = String(Math.floor(segundosRestantes / 60)).padStart(2, '0');
    const s = String(segundosRestantes % 60).padStart(2, '0');
    cdEl.innerText = `Expira em ${m}:${s}`;
  }, 1000);

  // Polling de status a cada 3s (fallback caso o WS não entregue)
  estado.pixPollTimer = setInterval(async () => {
    if (!estado.pixAtivo || !estado.pixOrderId) { clearInterval(estado.pixPollTimer); return; }
    let statusData;
    try {
      statusData = await window.pdv.pagarmeStatusPix({ order_id: estado.pixOrderId });
      if (statusData) console.log('[PIX][poll] status:', statusData.status);
    } catch (e) {
      console.warn('[PIX][poll] Erro ao consultar status:', e.message); return;
    }
    if (statusData?.status === 'paid') {
      console.log('[PIX][poll] Confirmado via polling!');
      await confirmarPagamentoPix(estado.pixOrderId);
    } else if (statusData?.status === 'failed' || statusData?.status === 'canceled') {
      clearInterval(estado.pixPollTimer);
      clearInterval(estado.pixTimer);
      fecharOverlayPix();
      mostrarErroCritico('PIX ' + (statusData.status === 'failed' ? 'recusado' : 'cancelado'), 'Tente novamente com outro método.');
      estado.pixAtivo = false;
      estado.pixOrderId = null;
    }
  }, 3000);

  console.log('[PIX] Overlay ativo. Aguardando confirmação de pagamento...');
}

async function obterNumeroVenda() {
  return estado.numeroVenda || '';
}

async function cancelarPix() {
  if (!estado.pixAtivo) {
    fecharOverlayPix();
    return;
  }

  clearInterval(estado.pixTimer);
  clearInterval(estado.pixPollTimer);

  const statusEl = document.getElementById('pix-status');
  if (statusEl) { statusEl.innerText = 'Cancelando...'; statusEl.style.color = '#f6c90e'; }

  if (estado.pixOrderId) {
    await window.pdv.pagarmeCancelarPix({ order_id: estado.pixOrderId });
  }

  estado.pixAtivo   = false;
  estado.pixOrderId = null;
  fecharOverlayPix();
  setLastItem('PIX cancelado. Escolha outra forma de pagamento.', '#f6c90e');
  dom.inputCodigo.focus();
}

function fecharOverlayPix() {
  clearInterval(estado.pixTimer);
  clearInterval(estado.pixPollTimer);
  const overlay = document.getElementById('pix-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function confirmarPagamentoPix(orderId) {
  if (!estado.pixAtivo) return;

  clearInterval(estado.pixTimer);
  clearInterval(estado.pixPollTimer);
  estado.pixAtivo   = false;
  estado.pixOrderId = null;

  // Atualiza UI do overlay
  const statusEl = document.getElementById('pix-status');
  if (statusEl) { statusEl.innerText = '✓ PIX aprovado! Finalizando venda...'; statusEl.style.color = '#22c55e'; }

  // Registra pagamento local como 'pix'
  const resPagto = await window.pdv.pagtoRegistrar({
    venda_id:           estado.vendaId,
    tipo_pagamento:     'pix',
    valor:              estado.total,
    referencia_externa: orderId,
  });

  if (!resPagto?.sucesso) {
    fecharOverlayPix();
    mostrarErro('Pagamento PIX aprovado mas falhou ao registrar: ' + (resPagto?.mensagem || ''));
    return;
  }

  // Finaliza a venda
  const itensPayload = estado.itens.map(i => ({
    produto_id:          i.produto_id,
    produto_nome:        i.produto_nome,
    quantidade:          i.quantidade,
    valor_unitario:      i.preco,
    desconto_item:       i.desconto_item,
    codigo_barras_usado: i.codigo_barras_usado,
    unidade_origem:      i.unidade_origem,
  }));

  const res = await window.pdv.vendaFinalizar({
    venda_id:  estado.vendaId,
    itens:     itensPayload,
    desconto:  estado.descontoGeral,
    acrescimo: 0,
  });

  fecharOverlayPix();

  if (!res?.sucesso) {
    mostrarErro('Venda não finalizada: ' + (res?.mensagem || 'Erro desconhecido'));
    return;
  }

  resetarVenda();
  setLastItem(`✓ Venda PIX finalizada! R$ ${estado.total?.toFixed(2) || '0,00'}`, '#22c55e');
}

// ─── Listener de eventos do processo principal ────────────────────────────────

// Comanda recebida via WebSocket
window.pdv.onComandoRemoto(async (tipo, data) => {
  if (tipo === 'enviar_comanda') {
    await carregarComanda(data);
  } else if (tipo === 'cancelar_venda' && estado.vendaAberta) {
    if (estado.vendaId === data.venda_id) {
      resetarVenda();
      setLastItem('⚠ Venda cancelada remotamente.', '#ff4d4d');
    }
  }
});

// ─── ATALHOS DE TECLADO ───────────────────────────────────────────────────────

document.addEventListener('keydown', async (e) => {

  // ── PIX ativo — Escape cancela ──────────────────────────────────────────────
  if (estado.pixAtivo) {
    if (e.key === 'Escape') { e.preventDefault(); cancelarPix(); }
    return;
  }

  // ── POS/TAP ativo — Escape cancela, demais teclas bloqueadas ────────────────
  if (estado.posAtivo) {
    if (e.key === 'Escape') { e.preventDefault(); cancelarPOS(); }
    return;
  }

  // ── Modal ativo ──────────────────────────────────────────────────────────────
  if (estado.modalAtivo) {
    if (e.key === 'Escape') { fecharModal(); return; }

    if (e.key === 'Enter') {
      const val = dom.modalInput.value.trim();

      switch (estado.modalAtivo) {
        case 'cpf':
          estado.cpf = val || 'CONSUMIDOR FINAL';
          if (val) {
            const cliente = await window.pdv.clienteBuscarCpf({ cpf: val });
            if (cliente) estado.cpf = `${cliente.nome} (${val})`;
          }
          await window.pdv.vendaAtualizar({
            venda_id: estado.vendaId, cliente_cpf: val || null, cliente_nome: estado.cpf,
          });
          break;

        case 'desc_geral':
          estado.descontoGeral = parseFloat(val) || 0;
          break;

        case 'desc_item':
          if (estado.selectedIndex !== -1) {
            estado.itens[estado.selectedIndex].desconto_item = parseFloat(val) || 0;
          }
          break;

        case 'pagamento':
          await confirmarPagamento(val);
          return;
      }

      fecharModal();
      atualizarUI();
    }
    return;
  }

  // ── Atalhos globais ───────────────────────────────────────────────────────────
  switch (e.key) {
    case 'F3':
      e.preventDefault();
      abrirVenda();
      break;

    case 'F2':
      e.preventDefault();
      if (estado.vendaAberta && estado.itens.length > 0) {
        mostrarModalPagamento();
      }
      break;

    case 'F4':
      e.preventDefault();
      if (estado.vendaAberta) mostrarModal('cpf', 'INFORMAR CPF / NOME DO CLIENTE');
      break;

    case 'F6':
      e.preventDefault();
      if (estado.vendaAberta) mostrarModal('desc_geral', 'DESCONTO NO TOTAL (R$)', estado.descontoGeral || '');
      break;

    case 'F7':
      e.preventDefault();
      if (estado.selectedIndex !== -1) {
        const item = estado.itens[estado.selectedIndex];
        mostrarModal('desc_item', `DESCONTO NO ITEM: ${item.produto_nome} (R$)`, item.desconto_item || '');
      }
      break;

    case 'Delete':
      if (estado.selectedIndex !== -1) {
        estado.itens.splice(estado.selectedIndex, 1);
        estado.selectedIndex = Math.min(estado.selectedIndex, estado.itens.length - 1);
        atualizarUI();
      }
      break;

    case 'Escape':
      if (estado.vendaAberta && confirm('Deseja cancelar a venda atual?')) {
        if (estado.vendaId) await window.pdv.vendaCancelar({ venda_id: estado.vendaId });
        resetarVenda();
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (estado.selectedIndex > 0) { estado.selectedIndex--; atualizarUI(); }
      break;

    case 'ArrowDown':
      e.preventDefault();
      if (estado.selectedIndex < estado.itens.length - 1) { estado.selectedIndex++; atualizarUI(); }
      break;
  }
});

// ─── MODAL DE PAGAMENTO ───────────────────────────────────────────────────────

async function mostrarModalPagamento() {
  console.log('[PAGAMENTO] F2 pressionado. vendaId:', estado.vendaId, '| total:', estado.total);
  const pagamentos = await window.pdv.pagtoListar({ venda_id: estado.vendaId });
  console.log('[PAGAMENTO] Pagamentos existentes:', pagamentos);
  if (pagamentos && pagamentos.length > 0) {
    mostrarErroCritico('Pagamento já registrado', 'Cancele a venda e reabra para trocar o método.');
    return;
  }

  mostrarModal(
    'pagamento',
    `PAGAMENTO — R$ ${estado.total.toFixed(2)}\n[1]Dinheiro  [2]PIX  [3]Débito  [4]Crédito  [5]Convênio`,
    ''  // FIX: era '1' por padrão — operador apertava Enter e processava como dinheiro
  );
}

/** Mapa: tecla → tipo_pagamento */
const TIPO_PAGAMENTO = {
  '1': 'dinheiro', '2': 'pix',        '3': 'pos_debito',
  '4': 'pos_credito', '5': 'convenio', '6': 'outros',
  'dinheiro': 'dinheiro', 'pix': 'pix', 'debito': 'pos_debito',
  'credito':  'pos_credito', 'convenio': 'convenio',
  'pos_debito': 'pos_debito', 'pos_credito': 'pos_credito',
};

// ─── FUNÇÃO confirmarPagamento ────────────────────────────────────────────────
async function confirmarPagamento(valorDigitado) {
  const TIPO_MAP = {
    '1': 'dinheiro', '2': 'pix',        '3': 'pos_debito',
    '4': 'pos_credito', '5': 'convenio', '6': 'outros',
    'dinheiro': 'dinheiro', 'pix': 'pix', 'debito': 'pos_debito',
    'credito':  'pos_credito', 'convenio': 'convenio',
    'pos_debito': 'pos_debito', 'pos_credito': 'pos_credito',
  };

  const tipo = TIPO_MAP[String(valorDigitado).toLowerCase()];
  console.log('[PAGAMENTO] confirmarPagamento | digitado:', JSON.stringify(valorDigitado), '| tipo:', tipo);

  if (!estado.vendaAberta || estado.itens.length === 0) {
    mostrarErro('Sem itens na venda.');
    return;
  }

  // ── PIX ────────────────────────────────────────────────────────────────────
  if (tipo === 'pix') {
    await iniciarPagamentoPix();
    return;
  }

  // ── Stone POS — débito ou crédito ──────────────────────────────────────────
 if (tipo === 'pos_debito' || tipo === 'pos_credito') {
    const tipoCartao = tipo === 'pos_debito' ? 'debit' : 'credit';
    await rotearGatewayCartao(tipoCartao);
    return;
  }


  // ── Dinheiro, convênio, outros — registra diretamente ─────────────────────
  const tiposValidos = ['dinheiro', 'convenio', 'outros'];
  if (!tiposValidos.includes(tipo)) {
    mostrarErro('Forma de pagamento inválida.');
    return;
  }

  const resPagto = await window.pdv.pagtoRegistrar({
    venda_id:       estado.vendaId,
    tipo_pagamento: tipo,
    valor:          estado.total,
  });

  if (!resPagto?.sucesso) {
    mostrarErro('Erro ao registrar pagamento: ' + (resPagto?.mensagem || ''));
    return;
  }

  const itensPayload = estado.itens.map(i => ({
    produto_id:          i.produto_id,
    produto_nome:        i.produto_nome,
    quantidade:          i.quantidade,
    valor_unitario:      i.preco,
    desconto_item:       i.desconto_item,
    codigo_barras_usado: i.codigo_barras_usado,
    unidade_origem:      i.unidade_origem,
  }));

  const res = await window.pdv.vendaFinalizar({
    venda_id:  estado.vendaId,
    itens:     itensPayload,
    desconto:  estado.descontoGeral,
    acrescimo: 0,
  });

  if (!res?.sucesso) {
    mostrarErro('Venda não finalizada: ' + (res?.mensagem || 'Erro desconhecido'));
    return;
  }

  resetarVenda();
  setLastItem(`✓ Venda (${tipo}) finalizada! R$ ${estado.total.toFixed(2).replace('.', ',')}`, '#22c55e');
}

/**
 * iniciarPagamentoTap
 *
 * Inicia pagamento via InfiniteTap (Tap to Pay no celular do operador).
 * Exibe um overlay com QR Code do deeplink para o operador escanear
 * com o celular que tem o InfinitePay instalado.
 * A confirmação chega via WebSocket (onPagarme 'confirmado').
 *
 * @param {'debit'|'credit'} tipo
 */
async function iniciarPagamentoTap(tipo) {
  if (!estado.vendaAberta || estado.itens.length === 0) return;

  if (estado.posAtivo) {
    mostrarErroCritico('Pagamento em andamento', 'Aguarde ou cancele o pagamento atual.');
    return;
  }

  // Parcelas (crédito): lê config ou assume 1
  const installments = tipo === 'credit'
    ? parseInt((await window.pdv.configGet('tap_installments')) || '1')
    : 1;

  estado.posAtivo   = true;
  estado.posTipo    = tipo;
  estado.posOrderId = null;

  // ── Overlay de espera ─────────────────────────────────────────────────────
  let overlay = document.getElementById('pos-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pos-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;z-index:9999;';
    document.body.appendChild(overlay);
  }

  const tipoLabel = tipo === 'debit' ? 'DÉBITO' : `CRÉDITO${installments > 1 ? ' ' + installments + 'x' : ''}`;

  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:2px solid #00c896;border-radius:12px;padding:32px 40px;max-width:440px;width:92%;text-align:center;color:#fff;">
      <div style="color:#00c896;font-size:1.3rem;font-weight:700;margin-bottom:12px;">
        📱 INFINITETAP — ${tipoLabel}
      </div>
      <div id="tap-status-msg" style="color:#aaa;font-size:0.9rem;margin-bottom:16px;">
        Gerando QR Code...
      </div>
      <div id="tap-valor" style="color:#fff;font-size:1.6rem;font-weight:800;margin:12px 0;"></div>
      <div id="tap-qr-container" style="margin:12px auto 16px;max-width:200px;"></div>
      <div id="tap-instrucao" style="color:#aaa;font-size:0.85rem;margin-bottom:20px;display:none;">
        Escaneie o QR com o celular do operador.<br>
        <span style="color:#00c896;">Toque o cartão do cliente no celular.</span>
      </div>
      <button id="tap-cancelar-btn" style="
        background:transparent;color:#ff4d4d;border:1px solid #ff4d4d;
        padding:8px 24px;border-radius:6px;cursor:pointer;font-size:0.85rem;
      ">Cancelar</button>
    </div>
  `;

  document.getElementById('tap-valor').innerText = `R$ ${estado.total.toFixed(2).replace('.', ',')}`;
  document.getElementById('tap-cancelar-btn').addEventListener('click', cancelarPOS);

  // ── Solicita criação da transação ao servidor ─────────────────────────────
  let res;
  try {
    res = await window.pdv.infinitetapEnviar({
      venda_id:       estado.vendaId,
      valor:          estado.total,
      numero_venda:   estado.numeroVenda || '',
      payment_method: tipo,
      installments,
    });
  } catch (e) {
    estado.posAtivo = false;
    fecharOverlayPOS();
    mostrarErroCritico('Erro InfiniteTap', String(e.message));
    return;
  }

  if (!res?.sucesso) {
    estado.posAtivo = false;
    fecharOverlayPOS();
    mostrarErroCritico('Erro ao iniciar InfiniteTap', res?.mensagem || 'Verifique a conexão com o servidor.');
    return;
  }

  estado.posOrderId = res.order_id;

  // ── Renderiza QR Code do deeplink ─────────────────────────────────────────
  const qrContainer = document.getElementById('tap-qr-container');
  const msgEl       = document.getElementById('tap-status-msg');
  const instrucao   = document.getElementById('tap-instrucao');

  try {
    // Usa a lib QRCode se disponível (npm install qrcode ou CDN)
    if (typeof QRCode !== 'undefined') {
      const canvas = document.createElement('canvas');
      qrContainer.appendChild(canvas);
      await QRCode.toCanvas(canvas, res.deeplink_url, {
        width: 180, margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } else {
      // Fallback sem lib: exibe a URL para copiar
      qrContainer.innerHTML = `
        <div style="background:#fff;color:#000;padding:8px;border-radius:4px;font-size:0.7rem;word-break:break-all;max-width:180px;margin:0 auto;">
          ${res.deeplink_url}
        </div>`;
    }

    if (msgEl)    { msgEl.innerText = '✓ QR gerado! Escaneie com o celular.'; msgEl.style.color = '#00c896'; }
    if (instrucao) instrucao.style.display = 'block';

  } catch (qrErr) {
    console.warn('[TAP] Erro ao gerar QR:', qrErr.message);
    if (msgEl) msgEl.innerText = 'Aguardando pagamento InfiniteTap...';
  }

  console.log('[TAP] order_id:', res.order_id, '| deeplink:', res.deeplink_url);

  // Timeout de segurança: 3 minutos
  estado.posTimer = setTimeout(() => {
    if (estado.posAtivo) {
      estado.posAtivo = false;
      fecharOverlayPOS();
      mostrarErro('Tempo limite InfiniteTap excedido. Tente novamente.');
    }
  }, 180_000);
}


/**
 * rotearGatewayCartao
 *
 * Lê a chave `gateway_cartao` do banco local e decide qual gateway chamar.
 * Toda a lógica de cada gateway permanece em sua própria função isolada.
 *
 * @param {'debit'|'credit'} tipoCartao
 */
async function rotearGatewayCartao(tipoCartao) {
  // Lê configuração do banco SQLite local (mesma fonte usada por device_serial_number)
  const gateway = (await window.pdv.configGet('gateway_cartao')) || 'pagarme_pos';

  console.log(`[GATEWAY] gateway_cartao = "${gateway}" | tipo = "${tipoCartao}"`);

  switch (gateway) {
    case 'infinitetap':
      await iniciarPagamentoTap(tipoCartao);
      break;

    case 'pagarme_pos':
    default:
      await iniciarPagamentoPOS(tipoCartao);
      break;
  }
}

// ─── iniciarPagamentoPOS ─────────────────────────────────────────────────────
async function iniciarPagamentoPOS(tipo) {
  if (!estado.vendaAberta || estado.itens.length === 0) return;

  if (estado.posAtivo) {
    mostrarErroCritico('POS em andamento', 'Aguarde o pagamento na maquininha ou cancele antes.');
    return;
  }

  // Lê serial da maquininha configurado no PDV
  const deviceSerial = await window.pdv.configGet('device_serial_number');
  if (!deviceSerial) {
    mostrarErroCritico(
      'Maquininha não configurada',
      'Acesse Configurações → insira o número serial da maquininha Stone (device_serial_number).'
    );
    return;
  }

  estado.posAtivo   = true;
  estado.posTipo    = tipo;
  estado.posOrderId = null;

  // ── Overlay de espera POS ─────────────────────────────────────────────────
  let overlay = document.getElementById('pos-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pos-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;z-index:9999;';
    document.body.appendChild(overlay);
  }

  const tipoLabel = tipo === 'debit' ? 'DÉBITO' : 'CRÉDITO';
  const tipoIcon  = tipo === 'debit' ? '💳' : '💰';

  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:#1a1a2e;border:2px solid #f6c90e;border-radius:12px;padding:32px 40px;max-width:440px;width:92%;text-align:center;color:#fff;">
      <div style="color:#f6c90e;font-size:1.3rem;font-weight:700;margin-bottom:12px;">${tipoIcon} PAGAMENTO ${tipoLabel} — STONE POS</div>
      <div id="pos-status-msg" style="color:#aaa;font-size:0.9rem;margin-bottom:16px;">Enviando para a maquininha...</div>
      <div id="pos-valor" style="color:#fff;font-size:1.6rem;font-weight:800;margin:12px 0;"></div>
      <div id="pos-device" style="color:#666;font-size:0.75rem;margin-bottom:20px;"></div>
      <div style="color:#aaa;font-size:0.85rem;margin-bottom:20px;">
        Aguardando pagamento na maquininha.<br>
        <span style="color:#f6c90e;">Apresente o cartão ao cliente.</span>
      </div>
      <button id="pos-cancelar-btn" style="
        background:transparent;color:#ff4d4d;border:1px solid #ff4d4d;
        padding:8px 24px;border-radius:6px;cursor:pointer;font-size:0.85rem;
      ">Cancelar</button>
    </div>
  `;

  document.getElementById('pos-valor').innerText  = `R$ ${estado.total.toFixed(2).replace('.', ',')}`;
  document.getElementById('pos-device').innerText = `Maquininha: ${deviceSerial}`;
  document.getElementById('pos-cancelar-btn').addEventListener('click', cancelarPOS);

  // ── Envia para a maquininha ───────────────────────────────────────────────
  let res;
  try {
    res = await window.pdv.pagarmeEnviarPos({
      venda_id:             estado.vendaId,
      valor:                estado.total,
      numero_venda:         estado.numeroVenda || '',
      device_serial_number: deviceSerial,
      tipo,
      installments:         1,
      installment_type:     'merchant',
      display_name:         `Venda #${estado.vendaId}`,
      print_receipt:        true,
    });
  } catch (e) {
    estado.posAtivo = false;
    fecharOverlayPOS();
    mostrarErroCritico('Erro IPC POS', String(e.message));
    return;
  }

  if (!res?.sucesso) {
    estado.posAtivo = false;
    fecharOverlayPOS();
    mostrarErroCritico('Erro ao enviar para maquininha', res?.mensagem || 'Verifique a conexão com o servidor.');
    return;
  }

  estado.posOrderId = res.order_id;

  const msgEl = document.getElementById('pos-status-msg');
  if (msgEl) {
    msgEl.innerText = '✓ Pedido enviado! Aguardando pagamento na maquininha...';
    msgEl.style.color = '#22c55e';
  }

  console.log('[POS] Pedido criado. order_id:', res.order_id, '| device:', deviceSerial);

  // Timeout de segurança: 3 minutos sem confirmação cancela a espera no PDV
  // (a cobrança na Pagar.me não é cancelada — o operador decide)
  estado.posTimer = setTimeout(() => {
    if (estado.posAtivo) {
      estado.posAtivo = false;
      fecharOverlayPOS();
      mostrarErro('Tempo limite excedido. Verifique a maquininha e tente novamente.');
    }
  }, 180_000);
}

async function cancelarPOS() {
  clearTimeout(estado.posTimer);

  const msgEl = document.getElementById('pos-status-msg') || document.getElementById('tap-status-msg');
  if (msgEl) { msgEl.innerText = 'Cancelando...'; msgEl.style.color = '#f6c90e'; }

  if (estado.posOrderId) {
    const gateway = (await window.pdv.configGet('gateway_cartao')) || 'pagarme_pos';

    if (gateway === 'infinitetap') {
      await window.pdv.infinitetapCancelar({ order_id: estado.posOrderId });
    } else {
      await window.pdv.pagarmeCancelarPos({ order_id: estado.posOrderId });
    }
  }

  estado.posAtivo   = false;
  estado.posOrderId = null;
  fecharOverlayPOS();
  setLastItem('Pagamento cancelado. Escolha outra forma.', '#f6c90e');
  dom.inputCodigo.focus();
}

// ─── fecharOverlayPOS ────────────────────────────────────────────────────────
function fecharOverlayPOS() {
  clearTimeout(estado.posTimer);
  const overlay = document.getElementById('pos-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── confirmarPagamentoPOS ───────────────────────────────────────────────────
async function confirmarPagamentoPOS(data) {
  if (!estado.posAtivo) return;

  clearTimeout(estado.posTimer);
  estado.posAtivo   = false;
  estado.posOrderId = null;

  fecharOverlayPOS();

  // Tipo de pagamento: usa o que veio no evento, ou o que o operador escolheu
  const tipo = data.tipo_pagamento || (estado.posTipo === 'debit' ? 'pos_debito' : 'pos_credito');

  const resPagto = await window.pdv.pagtoRegistrar({
    venda_id:           estado.vendaId,
    tipo_pagamento:     tipo,
    valor:              estado.total,
    referencia_externa: data.order_id || '',
  });

  if (!resPagto?.sucesso) {
    mostrarErro('Pagamento aprovado na maquininha, mas falhou ao registrar: ' + (resPagto?.mensagem || ''));
    return;
  }

  const itensPayload = estado.itens.map(i => ({
    produto_id:          i.produto_id,
    produto_nome:        i.produto_nome,
    quantidade:          i.quantidade,
    valor_unitario:      i.preco,
    desconto_item:       i.desconto_item,
    codigo_barras_usado: i.codigo_barras_usado,
    unidade_origem:      i.unidade_origem,
  }));

  const res = await window.pdv.vendaFinalizar({
    venda_id:  estado.vendaId,
    itens:     itensPayload,
    desconto:  estado.descontoGeral,
    acrescimo: 0,
  });

  if (!res?.sucesso) {
    mostrarErro('Venda não finalizada: ' + (res?.mensagem || 'Erro'));
    return;
  }

  const tipoLabel = tipo === 'pos_debito' ? 'Débito' : tipo === 'pos_credito' ? 'Crédito' : tipo;
  resetarVenda();
  setLastItem(`✓ Venda ${tipoLabel} (POS) finalizada! R$ ${estado.total?.toFixed(2) || ''}`, '#22c55e');
}

// ─── Listener WebSocket: PIX + POS + InfiniteTap ─────────────────────────────
window.pdv.onPagarme((tipo, data) => {
  // ── PIX confirmado ────────────────────────────────────────────────────────
  if (tipo === 'confirmado' && estado.pixAtivo) {
    confirmarPagamentoPix(data.order_id || estado.pixOrderId);
    return;
  }

  // ── POS / InfiniteTap confirmado ──────────────────────────────────────────
  if (tipo === 'confirmado' && estado.posAtivo) {
    const gatewayLabel = data.gateway === 'infinitetap' ? 'InfiniteTap' : 'Stone POS';
    console.log(`[GATEWAY] Confirmado via ${gatewayLabel}`, data);
    confirmarPagamentoPOS(data);
    return;
  }

  // ── PIX cancelado ─────────────────────────────────────────────────────────
  if (tipo === 'cancelado' && estado.pixAtivo) {
    clearInterval(estado.pixTimer);
    clearInterval(estado.pixPollTimer);
    fecharOverlayPix();
    estado.pixAtivo   = false;
    estado.pixOrderId = null;
    mostrarErro('PIX cancelado: ' + (data.mensagem || 'tente novamente.'));
    return;
  }

  // ── POS / InfiniteTap cancelado ───────────────────────────────────────────
  if (tipo === 'cancelado' && estado.posAtivo) {
    const motivo = data.warning || data.mensagem || 'Cancelado.';
    estado.posAtivo   = false;
    estado.posOrderId = null;
    clearTimeout(estado.posTimer);
    fecharOverlayPOS();
    mostrarErro(`Pagamento cancelado: ${motivo}`);
    return;
  }

});

// ─── INPUT DE CÓDIGO DE BARRAS ────────────────────────────────────────────────

dom.inputCodigo.addEventListener('keypress', async (e) => {
  if (e.key !== 'Enter') return;

  const input = dom.inputCodigo.value.trim();
  dom.inputCodigo.value = '';
  if (!input) return;

  // Lança rápido: "N*codigo" ou "N*"
  const multMatch = input.match(/^(\d+)\*(.*)$/);
  if (multMatch) {
    const qtd    = parseInt(multMatch[1], 10);
    const codigo = multMatch[2].trim();

    if (qtd > 0 && qtd <= 9999) {
      estado.quantidadePendente = qtd;
      atualizarDisplayQtdPendente();
    } else {
      setLastItem('⚠ Quantidade inválida (1–9999).', '#ff4d4d');
      return;
    }

    if (codigo) {
      await adicionarProduto(codigo);
    } else {
      setLastItem(`Quantidade definida: ${qtd}× — bipie o produto...`, '#f6c90e');
    }
    return;
  }

  await adicionarProduto(input);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resetarVenda() {
  fecharOverlayPix();
  fecharOverlayPOS();
  estado.vendaAberta        = false;
  estado.vendaId            = null;
  estado.itens              = [];
  estado.descontoGeral      = 0;
  estado.quantidadePendente = 1;
  estado.pixAtivo           = false;
  estado.pixOrderId         = null;
  estado.posAtivo           = false;
  estado.posOrderId         = null;
  estado.posTimer           = null;
  dom.inputCodigo.disabled  = true;
  dom.inputCodigo.placeholder = '';
  atualizarUI();
}