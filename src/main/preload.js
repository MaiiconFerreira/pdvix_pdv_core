// preload.js — PDVix Electron
// ADICIONADO: pagarmeEnviarPos, pagarmeCancelarPos, pagarmeStatusPos
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdv', {
  // ── Auth ───────────────────────────────────────────────────────────────────
  login:            (d) => ipcRenderer.invoke('auth:login', d),
  logout:           ()  => ipcRenderer.invoke('auth:logout'),
  usuarioAtual:     ()  => ipcRenderer.invoke('auth:current'),

  // ── Caixa ──────────────────────────────────────────────────────────────────
  caixaStatus:      ()  => ipcRenderer.invoke('caixa:status'),
  caixaAbrir:       (d) => ipcRenderer.invoke('caixa:abrir', d),
  caixaFechar:      ()  => ipcRenderer.invoke('caixa:fechar'),
  caixaResumo:      ()  => ipcRenderer.invoke('caixa:resumo'),

  // ── Sangria ────────────────────────────────────────────────────────────────
  sangria:          (d) => ipcRenderer.invoke('sangria:registrar', d),

  // ── Produtos ───────────────────────────────────────────────────────────────
  buscarCodigo:     (d) => ipcRenderer.invoke('produto:buscar', d),
  pesquisarProduto: (d) => ipcRenderer.invoke('produto:pesquisar', d),

  // ── Vendas ─────────────────────────────────────────────────────────────────
  vendaCriar:       ()  => ipcRenderer.invoke('venda:criar'),
  vendaCancelar:    (d) => ipcRenderer.invoke('venda:cancelar', d),
  vendaAtualizar:   (d) => ipcRenderer.invoke('venda:atualizar', d),
  vendaFinalizar:   (d) => ipcRenderer.invoke('venda:finalizar', d),

  // ── Pagamentos ─────────────────────────────────────────────────────────────
  pagtoRegistrar:   (d) => ipcRenderer.invoke('pagamento:registrar', d),
  pagtoListar:      (d) => ipcRenderer.invoke('pagamento:listar', d),

  // ── Pagar.me — PIX ─────────────────────────────────────────────────────────
  pagarmeCriarPix:    (d) => ipcRenderer.invoke('pagarme:criarPix',    d),
  pagarmeCancelarPix: (d) => ipcRenderer.invoke('pagarme:cancelarPix', d),
  pagarmeStatusPix:   (d) => ipcRenderer.invoke('pagarme:statusPix',   d),

  // ── Pagar.me — Stone POS (débito, crédito, PIX na maquininha) — NOVO ────────
  // pagarmeEnviarPos({ venda_id, valor, numero_venda, device_serial_number,
  //                    tipo, installments, installment_type, display_name,
  //                    print_receipt, cliente_nome, cliente_cpf, cliente_email })
  // Retorna: { sucesso, order_id, status, device_serial_number, tipo, mensagem? }
  // O pagamento é confirmado via evento onPagarme('confirmado', data)
  pagarmeEnviarPos:    (d) => ipcRenderer.invoke('pagarme:enviarPos',    d),
  pagarmeCancelarPos:  (d) => ipcRenderer.invoke('pagarme:cancelarPos',  d),
  pagarmeStatusPos:    (d) => ipcRenderer.invoke('pagarme:statusPos',    d),

   // ── InfiniteTap — Tap to Pay via app InfinitePay no celular ─────────────────
  //
  // infinitetapEnviar({ venda_id, valor, numero_venda, payment_method,
  //                     installments, handle?, doc_number? })
  //   → Cria a transação no servidor e retorna o deeplink_url para QR Code.
  //   → O PDV exibe o QR para o operador escanear com o celular.
  //   → Confirmação chega via onPagarme('confirmado', data) com data.gateway === 'infinitetap'
  //
  // infinitetapCancelar({ order_id })
  //   → Cancela a order pendente (operador desistiu).
  //
  // infinitetapStatus({ order_id })
  //   → Polling de fallback para verificar status sem WebSocket.

  infinitetapEnviar:  (d) => ipcRenderer.invoke('infinitetap:enviar',  d),
  infinitetapCancelar:(d) => ipcRenderer.invoke('infinitetap:cancelar', d),
  infinitetapStatus:  (d) => ipcRenderer.invoke('infinitetap:status',  d),

  // ── Cancelamentos ──────────────────────────────────────────────────────────
  cancelamentoRegistrar: (d) => ipcRenderer.invoke('cancelamento:registrar', d),
  cancelamentoListar:    (d) => ipcRenderer.invoke('cancelamento:listar', d),

  // ── Supervisor ─────────────────────────────────────────────────────────────
  supervisorCartao: (d) => ipcRenderer.invoke('supervisor:validarCartao', d),
  supervisorLogin:  (d) => ipcRenderer.invoke('supervisor:validarLogin', d),

  // ── Cliente ────────────────────────────────────────────────────────────────
  clienteBuscarCpf: (d) => ipcRenderer.invoke('cliente:buscarCpf', d),

  // ── Sistema / Config ───────────────────────────────────────────────────────
  sistemaStatus:    ()  => ipcRenderer.invoke('sistema:status'),
  cargaInicial:     ()  => ipcRenderer.invoke('sistema:cargaInicial'),
  configGet:        (c) => ipcRenderer.invoke('config:get', c),
  configSet:        (d) => ipcRenderer.invoke('config:set', d),

  // ── WebSocket ──────────────────────────────────────────────────────────────
  wsStatus:         ()  => ipcRenderer.invoke('ws:status'),

  // ── Eventos do processo principal → renderer ───────────────────────────────
  onWsStatus:       (cb) => ipcRenderer.on('ws:status',        (_e, d) => cb(d)),
  onWsComando:      (cb) => ipcRenderer.on('cmd:fechar_caixa', (_e, d) => cb('fechar_caixa', d)),
  onPagarme:        (cb) => {
    ipcRenderer.on('pagarme:pendente',    (_e, d) => cb('pendente',    d));
    ipcRenderer.on('pagarme:confirmado',  (_e, d) => cb('confirmado',  d));
    ipcRenderer.on('pagarme:cancelado',   (_e, d) => cb('cancelado',   d));
  },
  onCargaAtualizada: (cb) => ipcRenderer.on('carga:atualizada', (_e, d) => cb(d)),
  onComandoRemoto:   (cb) => {
    ipcRenderer.on('cmd:cancelar_venda',  (_e, d) => cb('cancelar_venda',  d));
    ipcRenderer.on('cmd:cancelar_item',   (_e, d) => cb('cancelar_item',   d));
    ipcRenderer.on('cmd:desconto_item',   (_e, d) => cb('desconto_item',   d));
    ipcRenderer.on('cmd:desconto_venda',  (_e, d) => cb('desconto_venda',  d));
    ipcRenderer.on('cmd:finalizar_venda', (_e, d) => cb('finalizar_venda', d));
    ipcRenderer.on('cmd:comanda',         (_e, d) => cb('enviar_comanda',  d));
  },

  caixaSyncServidor: () => ipcRenderer.invoke('caixa:syncServidor'),
  
});