// venda.js — PDVix Renderer — Lógica do PDV
// ─────────────────────────────────────────────────────────────────────────────
// API disponível via preload: window.pdv.*
// Atalhos:
//   F3           → Abrir venda
//   F2           → Finalizar venda
//   F4           → Informar CPF/nome do cliente
//   F6           → Desconto no total
//   F7           → Desconto no item selecionado
//   Delete       → Remover item selecionado
//   Escape       → Cancelar venda
//   ArrowUp/Down → Navegar entre itens
//
// Lançamento rápido de quantidade:
//   Digite "N*" no campo de código para definir a quantidade do próximo produto.
//   Exemplos:
//     "3*"            → define quantidade pendente = 3, aguarda próximo scan/código
//     "3*7891234"     → adiciona 3 unidades do produto com código 7891234
//     "10*"  + [scan] → 10 unidades do produto bipado a seguir
// ─────────────────────────────────────────────────────────────────────────────

let estado = {
  vendaAberta:        false,
  vendaId:            null,      // ID no SQLite local (retornado por venda:criar)
  itens:              [],
  subtotal:           0,
  descontoGeral:      0,
  total:              0,
  cpf:                'CONSUMIDOR FINAL',
  selectedIndex:      -1,
  modalAtivo:         null,      // 'cpf' | 'desc_geral' | 'desc_item' | 'pagamento'
  quantidadePendente: 1,         // quantidade para o próximo produto (default 1)
};

const dom = {
  inputCodigo:    document.getElementById('codigo-barras'),
  tabela:         document.querySelector('#tabela-itens tbody'),
  subtotal:       document.getElementById('val-subtotal'),
  desconto:       document.getElementById('val-desconto'),
  total:          document.getElementById('val-total'),
  status:         document.getElementById('display-status'),
  cpf:            document.getElementById('display-cpf'),
  lastItem:       document.getElementById('display-last-item'),
  qtdPendente:    document.getElementById('display-qtd-pendente'), // pode não existir
  modal:          document.getElementById('modal-container'),
  modalTitle:     document.getElementById('modal-title'),
  modalInput:     document.getElementById('modal-input'),
};

// ─── FUNÇÕES DE ESTADO ────────────────────────────────────────────────────────

async function abrirVenda() {
  if (estado.vendaAberta) return;

  const res = await window.pdv.vendaCriar();
  if (!res?.sucesso) {
    alert('Não foi possível abrir a venda: ' + (res?.mensagem || 'Erro desconhecido'));
    return;
  }

  estado = {
    ...estado,
    vendaAberta:        true,
    vendaId:            res.venda_id,
    itens:              [],
    subtotal:           0,
    descontoGeral:      0,
    total:              0,
    cpf:                'CONSUMIDOR FINAL',
    selectedIndex:      -1,
    quantidadePendente: 1,
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
    dom.lastItem.innerText = `⚠ Produto não encontrado: ${codigo}`;
    dom.lastItem.style.color = '#ff4d4d';
    return;
  }

  const p = result.produto;
  // Normaliza o preço: usa preco_embalagem se disponível, fallback para preco_venda
  const preco = parseFloat(p.preco_embalagem ?? p.preco_venda ?? 0);
  const qtd   = estado.quantidadePendente || 1;

  // Se o mesmo produto já está na lista, incrementa a quantidade
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
      codigo_barras_usado: p.codigo_barras   || '',
      unidade_origem:      p.tipo_embalagem  || 'UN',
      valor_unitario:      preco,
      uid:                 Date.now(),
    });
    estado.selectedIndex = estado.itens.length - 1;
  }

  // Reseta quantidade pendente
  estado.quantidadePendente = 1;
  atualizarDisplayQtdPendente();

  dom.lastItem.style.color = '';
  dom.lastItem.innerText   = `${p.nome}  ×${qtd}  — R$ ${preco.toFixed(2)}`;
  atualizarUI();
}

function atualizarUI() {
  // ── Tabela de itens ──────────────────────────────────────────────────────────
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

  // ── Totais ───────────────────────────────────────────────────────────────────
  const descontoItens = estado.itens.reduce((a, b) => a + b.desconto_item, 0);
  estado.total = estado.subtotal - estado.descontoGeral - descontoItens;

  dom.subtotal.innerText = `R$ ${estado.subtotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  dom.desconto.innerText = `- R$ ${(estado.descontoGeral + descontoItens).toFixed(2)}`;
  dom.total.innerText    = `R$ ${estado.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

  // ── Status / CPF ─────────────────────────────────────────────────────────────
  dom.status.innerText        = estado.vendaAberta ? 'VENDA EM ANDAMENTO' : 'CAIXA LIVRE';
  dom.status.style.borderColor = estado.vendaAberta ? '#00f2ff' : '#718096';
  dom.cpf.innerText            = estado.cpf;

  atualizarDisplayQtdPendente();
}

/** Atualiza o indicador visual de quantidade pendente (se o elemento existir no HTML) */
function atualizarDisplayQtdPendente() {
  if (!dom.qtdPendente) return;
  if (estado.quantidadePendente > 1) {
    dom.qtdPendente.innerText      = `QTD: ${estado.quantidadePendente}×`;
    dom.qtdPendente.style.display  = 'inline-block';
    dom.qtdPendente.style.color    = '#f6c90e';
  } else {
    dom.qtdPendente.style.display  = 'none';
  }
}

// ─── CONTROLE DE MODAL ────────────────────────────────────────────────────────

function mostrarModal(tipo, titulo, valorInicial = '') {
  estado.modalAtivo     = tipo;
  dom.modalTitle.innerText = titulo;
  dom.modalInput.value  = valorInicial;
  dom.modal.style.display = 'flex';
  dom.modalInput.focus();
}

function fecharModal() {
  dom.modal.style.display = 'none';
  estado.modalAtivo       = null;
  dom.inputCodigo.focus();
}

// ─── ATALHOS DE TECLADO ───────────────────────────────────────────────────────

document.addEventListener('keydown', async (e) => {

  // ── Modal ativo ──────────────────────────────────────────────────────────────
  if (estado.modalAtivo) {
    if (e.key === 'Escape') {
      fecharModal();
      return;
    }

    if (e.key === 'Enter') {
      const val = dom.modalInput.value.trim();

      switch (estado.modalAtivo) {
        case 'cpf':
          estado.cpf = val || 'CONSUMIDOR FINAL';
          // Busca cliente pelo CPF para preencher nome automaticamente
          if (val) {
            const cliente = await window.pdv.clienteBuscarCpf({ cpf: val });
            if (cliente) estado.cpf = `${cliente.nome} (${val})`;
          }
          // Atualiza cliente na venda local
          await window.pdv.vendaAtualizar({
            venda_id:     estado.vendaId,
            cliente_cpf:  val || null,
            cliente_nome: estado.cpf,
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
          return; // confirmarPagamento cuida de fechar o modal
      }

      fecharModal();
      atualizarUI();
    }
    return;
  }

  // ── Atalhos globais (sem modal) ───────────────────────────────────────────────
  switch (e.key) {
    case 'F3':
      e.preventDefault();
      abrirVenda();
      break;

    case 'F2':
      e.preventDefault();
      if (estado.vendaAberta && estado.itens.length > 0) {
        mostrarModal(
          'pagamento',
          `PAGAMENTO — Total: R$ ${estado.total.toFixed(2)}\n[1]Dinheiro [2]Pix [3]Débito [4]Crédito`,
          '1'
        );
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
        if (estado.vendaId) {
          await window.pdv.vendaCancelar({ venda_id: estado.vendaId });
        }
        estado.vendaAberta = false;
        estado.vendaId     = null;
        estado.itens       = [];
        estado.quantidadePendente = 1;
        dom.inputCodigo.disabled  = true;
        atualizarUI();
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

// ─── INPUT DE CÓDIGO DE BARRAS ────────────────────────────────────────────────

dom.inputCodigo.addEventListener('keypress', async (e) => {
  if (e.key !== 'Enter') return;

  const input = dom.inputCodigo.value.trim();
  dom.inputCodigo.value = '';

  if (!input) return;

  // ── Lança rápido de quantidade: padrão "N*codigo" ou "N*" ──────────────────
  // Exemplos:
  //   "3*7891234"  → adiciona 3 unidades do produto 7891234
  //   "3*"         → define quantidade pendente = 3, aguarda próximo scan
  const multMatch = input.match(/^(\d+)\*(.*)$/);

  if (multMatch) {
    const qtd    = parseInt(multMatch[1], 10);
    const codigo = multMatch[2].trim();

    if (qtd > 0 && qtd <= 9999) {
      estado.quantidadePendente = qtd;
      atualizarDisplayQtdPendente();
    } else {
      dom.lastItem.innerText   = '⚠ Quantidade inválida (1–9999).';
      dom.lastItem.style.color = '#ff4d4d';
      return;
    }

    if (codigo) {
      // "N*codigo" → adiciona diretamente
      await adicionarProduto(codigo);
    } else {
      // "N*" sozinho → aguarda o próximo scan
      dom.lastItem.innerText   = `Quantidade definida: ${qtd}× — bipie o produto...`;
      dom.lastItem.style.color = '#f6c90e';
    }
    return;
  }

  // ── Código normal → adiciona produto ─────────────────────────────────────
  await adicionarProduto(input);
});

// ─── FINALIZAR VENDA ─────────────────────────────────────────────────────────

/** Mapa: tecla digitada no modal → tipo_pagamento */
const TIPO_PAGAMENTO = {
  '1': 'dinheiro',
  '2': 'pix',
  '3': 'pos_debito',
  '4': 'pos_credito',
  '5': 'convenio',
  '6': 'outros',
  // aceita também os nomes diretamente
  'dinheiro':    'dinheiro',
  'pix':         'pix',
  'debito':      'pos_debito',
  'credito':     'pos_credito',
  'convenio':    'convenio',
  'pos_debito':  'pos_debito',
  'pos_credito': 'pos_credito',
};

async function confirmarPagamento(valorDigitado) {
  const tipo = TIPO_PAGAMENTO[valorDigitado.toLowerCase()] || 'dinheiro';

  fecharModal();

  // 1. Registra o pagamento no SQLite local
  const resPagto = await window.pdv.pagtoRegistrar({
    venda_id:    estado.vendaId,
    tipo_pagamento: tipo,
    valor:       estado.total,
  });

  if (!resPagto?.sucesso) {
    alert('Erro ao registrar pagamento: ' + (resPagto?.mensagem || 'Erro desconhecido'));
    return;
  }

  // 2. Finaliza a venda (grava itens, calcula totais, tenta sync imediato)
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
    alert('Erro ao finalizar venda: ' + (res?.mensagem || 'Erro desconhecido'));
    return;
  }

  alert(`✓ Venda finalizada!\nTotal: R$ ${estado.total.toFixed(2)}\nForma: ${tipo}`);

  // Reset estado
  estado.vendaAberta        = false;
  estado.vendaId            = null;
  estado.itens              = [];
  estado.quantidadePendente = 1;
  dom.inputCodigo.disabled  = true;
  dom.lastItem.innerText    = '';
  dom.lastItem.style.color  = '';
  atualizarUI();
}