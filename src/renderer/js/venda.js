let estado = {
    vendaAberta: false,
    itens: [],
    subtotal: 0,
    descontoGeral: 0,
    total: 0,
    cpf: "CONSUMIDOR FINAL",
    selectedIndex: -1,
    modalAtivo: null // 'cpf', 'desc_geral', 'desc_item'
};

const dom = {
    inputCodigo: document.getElementById('codigo-barras'),
    tabela: document.querySelector('#tabela-itens tbody'),
    subtotal: document.getElementById('val-subtotal'),
    desconto: document.getElementById('val-desconto'),
    total: document.getElementById('val-total'),
    status: document.getElementById('display-status'),
    cpf: document.getElementById('display-cpf'),
    lastItem: document.getElementById('display-last-item'),
    modal: document.getElementById('modal-container'),
    modalTitle: document.getElementById('modal-title'),
    modalInput: document.getElementById('modal-input')
};

// --- FUNÇÕES DE ESTADO ---

function abrirVenda() {
    if (estado.vendaAberta) return;
    estado = { ...estado, vendaAberta: true, itens: [], subtotal: 0, descontoGeral: 0, total: 0, cpf: "CONSUMIDOR FINAL", selectedIndex: -1 };
    dom.inputCodigo.disabled = false;
    dom.inputCodigo.placeholder = "Passe o scanner...";
    dom.inputCodigo.focus();
    atualizarUI();
}

async function adicionarProduto(codigo) {
    if (!estado.vendaAberta) return;
    
    try {
        const produto = await window.api.buscarProduto(codigo);
        if (produto) {
            const novoItem = {
                ...produto,
                quantidade: 1,
                desconto: 0,
                uid: Date.now() // Unique ID para remoção
            };
            estado.itens.push(novoItem);
            estado.selectedIndex = estado.itens.length - 1;
            dom.lastItem.innerText = `${produto.nome} - R$ ${produto.preco.toFixed(2)}`;
            atualizarUI();
        }
    } catch (e) { console.error(e); }
}

function atualizarUI() {
    // Tabela
    dom.tabela.innerHTML = '';
    estado.subtotal = 0;

    estado.itens.forEach((item, idx) => {
        const itemSubtotal = (item.preco * item.quantidade) - item.desconto;
        estado.subtotal += (item.preco * item.quantidade);
        
        const tr = document.createElement('tr');
        if (idx === estado.selectedIndex) tr.className = 'selected';
        
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${item.nome}</td>
            <td>${item.quantidade}</td>
            <td>R$ ${item.preco.toFixed(2)}</td>
            <td style="color: #ff4d4d">- R$ ${item.desconto.toFixed(2)}</td>
            <td>R$ ${itemSubtotal.toFixed(2)}</td>
        `;
        dom.tabela.appendChild(tr);
        if (idx === estado.selectedIndex) tr.scrollIntoView({ block: 'center' });
    });

    // Totais
    estado.total = estado.subtotal - estado.descontoGeral - estado.itens.reduce((a, b) => a + b.desconto, 0);
    
    dom.subtotal.innerText = `R$ ${estado.subtotal.toLocaleString('pt-br', {minimumFractionDigits: 2})}`;
    dom.desconto.innerText = `- R$ ${(estado.descontoGeral + estado.itens.reduce((a, b) => a + b.desconto, 0)).toFixed(2)}`;
    dom.total.innerText = `R$ ${estado.total.toLocaleString('pt-br', {minimumFractionDigits: 2})}`;
    
    dom.status.innerText = estado.vendaAberta ? "VENDA EM ANDAMENTO" : "CAIXA LIVRE";
    dom.status.style.borderColor = estado.vendaAberta ? "#00f2ff" : "#718096";
    dom.cpf.innerText = estado.cpf;
}

// --- CONTROLE DE MODAL ---

function mostrarModal(tipo, titulo) {
    estado.modalAtivo = tipo;
    dom.modalTitle.innerText = titulo;
    dom.modalInput.value = '';
    dom.modal.style.display = 'flex';
    dom.modalInput.focus();
}

function fecharModal() {
    dom.modal.style.display = 'none';
    estado.modalAtivo = null;
    dom.inputCodigo.focus();
}

// --- ATALHOS DE TECLADO ---

document.addEventListener('keydown', (e) => {
    // Se o modal estiver ativo
    if (estado.modalAtivo) {
        if (e.key === 'Escape') fecharModal();
        if (e.key === 'Enter') {
            const val = dom.modalInput.value;
            if (estado.modalAtivo === 'cpf') estado.cpf = val || "CONSUMIDOR FINAL";
            if (estado.modalAtivo === 'desc_geral') estado.descontoGeral = parseFloat(val) || 0;
            if (estado.modalAtivo === 'desc_item' && estado.selectedIndex !== -1) {
                estado.itens[estado.selectedIndex].desconto = parseFloat(val) || 0;
            }
            fecharModal();
            atualizarUI();
        }
        return;
    }

    // Atalhos Globais
    switch(e.key) {
        case 'F3': abrirVenda(); break;
        case 'F2': finalizarVenda(); break;
        case 'F4': if(estado.vendaAberta) mostrarModal('cpf', 'INFORMAR CPF/NOME'); break;
        case 'F6': if(estado.vendaAberta) mostrarModal('desc_geral', 'DESCONTO NO TOTAL (R$)'); break;
        case 'F7': if(estado.selectedIndex !== -1) mostrarModal('desc_item', 'DESCONTO NO ITEM (R$)'); break;
        case 'Delete': 
            if(estado.selectedIndex !== -1) {
                estado.itens.splice(estado.selectedIndex, 1);
                estado.selectedIndex = estado.itens.length - 1;
                atualizarUI();
            }
            break;
        case 'Escape': 
            if(confirm("Deseja cancelar a venda atual?")) {
                estado.vendaAberta = false;
                estado.itens = [];
                dom.inputCodigo.disabled = true;
                atualizarUI();
            }
            break;
        case 'ArrowUp':
            if(estado.selectedIndex > 0) {
                estado.selectedIndex--;
                atualizarUI();
            }
            break;
        case 'ArrowDown':
            if(estado.selectedIndex < estado.itens.length -1) {
                estado.selectedIndex++;
                atualizarUI();
            }
            break;
    }
});

dom.inputCodigo.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const cod = dom.inputCodigo.value.trim();
        if (cod) adicionarProduto(cod);
        dom.inputCodigo.value = '';
    }
});

async function finalizarVenda() {
    if (!estado.vendaAberta || estado.itens.length === 0) return;
    
    const dados = {
        total: estado.total,
        pagamento: 'Dinheiro', // Simplificado para o exemplo
        itens: estado.itens
    };

    const res = await window.api.registrarVenda(dados);
    if(res.sucesso) {
        alert("Venda Finalizada!");
        estado.vendaAberta = false;
        dom.inputCodigo.disabled = true;
        atualizarUI();
    }
}