// preload.js — PDVix Electron
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

  // ── Supervisor ─────────────────────────────────────────────────────────────
  supervisorCartao: (d) => ipcRenderer.invoke('supervisor:validarCartao', d),
  supervisorLogin:  (d) => ipcRenderer.invoke('supervisor:validarLogin', d),

  // ── Cliente ────────────────────────────────────────────────────────────────
  clienteBuscarCpf: (d) => ipcRenderer.invoke('cliente:buscarCpf', d),

  // ── Sistema ────────────────────────────────────────────────────────────────
  sistemaStatus:    ()  => ipcRenderer.invoke('sistema:status'),
  cargaInicial:     ()  => ipcRenderer.invoke('sistema:cargaInicial'),
});