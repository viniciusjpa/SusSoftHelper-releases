// ==UserScript==
// @name         SUS Software – Automação SOAP (PSF)
// @namespace    viverbem
// @version      1.4.0
// @description  Preenche o SOAP a partir de atalhos do AHK, abre o SOAP automaticamente, recolhe Antecedentes, marca o tipo de atendimento, adiciona botões na barra superior (fixa), adiciona vários cidadãos na fila de uma vez e lança resultados de exames digitados em texto livre.
// @author       Vinicius Farias Freitas
// @match        https://app.sussoftwareoficial.com.br/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://github.com/viniciusjpa/SusSoftHelper-releases/raw/refs/heads/main/sus-soap-templates.user.js
// @downloadURL  https://github.com/viniciusjpa/SusSoftHelper-releases/raw/refs/heads/main/sus-soap-templates.user.js
// ==/UserScript==

(function () {
    'use strict';
    if (window.SUSAUTO) return; // já carregado nesta aba

    // Lida do cabeçalho "@version" pelo Tampermonkey; mude lá a cada alteração
    const VERSAO = typeof GM_info !== 'undefined' ? GM_info.script.version : '?';

    /* =====================================================================
     * CONFIGURAÇÃO
     * ===================================================================== */
    const CFG = {
        // Prefixo que o AHK coloca na área de transferência antes do JSON
        prefixo: '##SUSSOAP##',

        urlListaAtendimentos: 'https://app.sussoftwareoficial.com.br/atendimento/lista-atendimentos'
            + '?somente_meus=true&somente_nao_finalizados=true'
            + '&status=aguardando&status=em_escuta_inicial&status=em_atendimento'
            + '&unidade_saude_id=765',

        urlViverBem: 'https://viverbemi.vercel.app/pacientes?q=',

        // Ordem de preferência quando nenhum "Tipo de atendimento" está marcado
        tiposAtendimento: ['tipo-consulta_agendada_programada', 'tipo-consulta_no_dia'],

        abrirSoapAutomaticamente: true,
        recolherAntecedentes: true,
        marcarTipoAtendimento: true,

        // Preenchido uma vez por atendimento ao entrar no SOAP ([] / '' desliga)
        sigtapPadrao: ['0301010064'],
        desfechoPadrao: 'liberar',
        focarSubjetivo: true, // ao final, volta ao topo com o cursor no Subjetivo

        timeoutBusca: 10000, // ms aguardando o resultado da busca de código

        // Lista de atendimentos: ao chegar nela sem o filtro "somente meus" (ex.: depois de finalizar
        // um atendimento), marca "Ver somente meus atendimentos" e aplica o filtro
        filtrarMeusAoAbrirLista: true,

        // Fila de recepção (botão "Adicionar na fila")
        tipoServicoFila: 'Consulta agendada', // texto exato da opção em "Tipo de serviço"
        tempoErroMs: 30000,                   // tempo que o painel de erros fica na tela
    };

    // Aparência da barra superior e dos modais (ajuste à vontade)
    const UI = {
        barraFixa: true,          // mantém a barra superior visível ao rolar a página
        escalaBotaoUsf: 0.8,      // botão da lotação (USF): 0.8 = 20% menor que o tamanho original
        folgaBotaoUsf: 12,        // px mínimos entre o botão da USF e os vizinhos
        larguraMinimaUsf: 200,    // px; se faltar espaço, o breadcrumb é encurtado para o botão caber
        botaoAltura: 30,          // px, botões inseridos pelo script
        botaoFonte: 12,           // px
        pacienteFonte: 13,        // px, linha "NOME (44a)" que aparece sob a barra ao rolar
        pacienteAltura: 16,       // px
        pacienteSubir: 2,         // px que o texto sobe em relação ao meio da faixa
        pacienteCor: '#000',
        modalExamesLargura: 980,  // px, largura máxima do modal de exames
        modalExamesAlturaTexto: 150, // px, altura da caixa de texto do modal de exames
        corNaoIdentificado: '#dc2626',
    };

    // Placeholders dos campos de texto do SOAP (início do texto basta)
    const CAMPOS = {
        subjetivo: 'Insira as impressões subjetivas',
        objetivo:  'Insira as demais informações relacionadas ao exame',
        avaliacao: 'Insira impressões adicionais sobre a avaliação',
        plano:     'Insira informações adicionais sobre o plano',
    };

    const SECOES = { subjetivo: 'Subjetivo', objetivo: 'Objetivo', avaliacao: 'Avaliação', plano: 'Plano' };

    const LOG = (...a) => console.log('%c[SUS-AUTO]', 'color:#16a34a;font-weight:bold', ...a);

    /* =====================================================================
     * UTILITÁRIOS DE DOM
     * ===================================================================== */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function esperar(fn, timeout = 5000, intervalo = 100) {
        const fim = Date.now() + timeout;
        while (Date.now() < fim) {
            const r = fn();
            if (r) return r;
            await sleep(intervalo);
        }
        return null;
    }

    const texto = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

    // Clique "de verdade" (Radix ativa abas/opções em pointerdown/mousedown)
    function clicar(el) {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const o = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
        return true;
    }

    // Define valor em input/textarea controlado pelo React
    function definirValor(el, valor) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const botaoPorTexto = (raiz, re) => [...raiz.querySelectorAll('button')].find((b) => re.test(texto(b)));

    // Códigos aparecem como "CÓDIGO - DESCRIÇÃO" (SIGTAP/CIAP) ou "DESCRIÇÃO - CÓDIGO" (CID 10)
    const normCod = (s) => s.toUpperCase().replace(/[.\s]/g, '');
    function textoTemCodigo(t, codigo) {
        const partes = t.split(' - ');
        const cod = normCod(codigo);
        return normCod(partes[0]) === cod || normCod(partes[partes.length - 1]) === cod;
    }

    // Já existe uma linha com esse código na tabela da seção? (ignora o próprio combobox)
    const jaAdicionado = (raiz, codigo) => [...raiz.querySelectorAll('*')].some((e) =>
        e.children.length === 0 && !e.closest('[role=combobox]') && textoTemCodigo(texto(e), codigo));

    /* =====================================================================
     * INDICADOR (verde = ouvindo / vermelho = trabalhando / laranja = falha)
     * ===================================================================== */
    const css = document.createElement('style');
    css.textContent = `
        #susauto-bar { display:flex; align-items:center; gap:8px; margin-right:4px; }
        #susauto-bar button { display:inline-flex; align-items:center; gap:6px; height:${UI.botaoAltura}px; padding:0 10px;
            border:1px solid #d1d5db; border-radius:8px; background:#fff; color:#1f3a5f;
            font-family:inherit; font-size:${UI.botaoFonte}px; font-weight:600; line-height:1;
            cursor:pointer; white-space:nowrap; transition:background .15s, border-color .15s; }
        #susauto-bar button:hover { background:#eff6ff; border-color:#93c5fd; }
        #susauto-bar button:disabled { opacity:.45; cursor:not-allowed; }
        #susauto-status { padding:0 8px !important; }
        #susauto-status .dot { width:10px; height:10px; border-radius:50%; background:#16a34a;
            box-shadow:0 0 0 0 rgba(22,163,74,.6); transition:background .2s; }
        #susauto-status[data-st=listening] .dot { animation: susauto-breath 2.4s ease-in-out infinite; }
        #susauto-status[data-st=working] .dot { background:#dc2626; animation: susauto-pulse .7s ease-in-out infinite; }
        #susauto-status[data-st=warn] .dot { background:#f59e0b; }
        @keyframes susauto-breath { 0%,100% { box-shadow:0 0 0 0 rgba(22,163,74,.55) } 50% { box-shadow:0 0 0 5px rgba(22,163,74,0) } }
        @keyframes susauto-pulse { 0%,100% { transform:scale(1); box-shadow:0 0 0 0 rgba(220,38,38,.6) } 50% { transform:scale(1.35); box-shadow:0 0 0 6px rgba(220,38,38,0) } }
        #susauto-bar.flutuante { position:fixed; left:12px; bottom:12px; z-index:2147483646;
            background:rgba(255,255,255,.92); padding:6px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.15); }
        #susauto-toast { position:fixed; right:16px; bottom:72px; z-index:2147483647; max-width:420px;
            padding:10px 14px; border-radius:10px; font:500 13px/1.4 system-ui,sans-serif; color:#fff;
            box-shadow:0 6px 20px rgba(0,0,0,.2); white-space:pre-line; opacity:0; transform:translateY(8px);
            transition:opacity .2s, transform .2s; pointer-events:none; }
        #susauto-toast.show { opacity:1; transform:none; }

        #susauto-bar button svg { width:14px; height:14px; flex-shrink:0; }
        #susauto-bar [hidden] { display:none !important; }

        /* Linha "NOME (idade)" presa sob a barra quando o cabeçalho do paciente sai da tela */
        /* Fica à frente dos elementos da barra (z-index) e sem corte (overflow visível): com faixa baixa
           ou pacienteSubir alto, o nome sobe por cima da barra em vez de ficar escondido */
        #susauto-paciente { position:absolute; z-index:50; left:0; right:0; top:100%; display:none; height:${UI.pacienteAltura}px;
            background:rgba(255,255,255,.95); border-bottom:1px solid #e5e7eb; box-shadow:0 2px 4px rgba(0,0,0,.05);
            color:${UI.pacienteCor}; font:700 ${UI.pacienteFonte}px/1 system-ui,sans-serif; letter-spacing:.02em;
            white-space:nowrap; overflow:visible; pointer-events:none; }
        #susauto-paciente.show { display:block; }
        /* Centro horizontal = centro do botão da USF (--centro, calculado no script) */
        #susauto-paciente span { position:absolute; top:50%; left:var(--centro, 50%);
            transform:translate(-50%, calc(-50% - ${UI.pacienteSubir}px)); }

        #susauto-exames-modal { position:fixed; inset:0; z-index:2147483640; display:none; align-items:center;
            justify-content:center; background:rgba(15,23,42,.35); font:13px/1.4 system-ui,sans-serif; }
        #susauto-exames-modal.show { display:flex; }
        #susauto-exames-modal .card { display:flex; flex-direction:column; gap:10px; width:min(${UI.modalExamesLargura}px, calc(100vw - 32px));
            max-height:calc(100vh - 32px); padding:16px; border-radius:12px; background:#fff; color:#1f2937;
            box-shadow:0 12px 40px rgba(0,0,0,.25); }
        #susauto-exames-modal .topo { display:flex; justify-content:space-between; align-items:center; font-size:15px; color:#1f3a5f; }
        #susauto-exames-modal .x { border:0; background:none; color:#64748b; font-size:22px; line-height:1; cursor:pointer; }
        #susauto-exames-modal .ajuda { margin:0; color:#475569; font-size:12px; }
        #susauto-exames-modal textarea { height:${UI.modalExamesAlturaTexto}px; flex-shrink:0; resize:vertical; padding:8px;
            border:1px solid #d1d5db; border-radius:8px; font:13px/1.5 ui-monospace,Consolas,monospace; }
        #susauto-exames-modal .naoid { display:none; padding:8px 10px; border:1px solid #fecaca; border-left:4px solid ${UI.corNaoIdentificado};
            border-radius:8px; background:#fef2f2; color:#7f1d1d; }
        #susauto-exames-modal .naoid.show { display:block; }
        #susauto-exames-modal .naoid b { color:${UI.corNaoIdentificado}; }
        #susauto-exames-modal .naoid ul { margin:4px 0 0; padding-left:18px; }
        #susauto-exames-modal .tabela { overflow:auto; min-height:60px; border:1px solid #e5e7eb; border-radius:8px; }
        #susauto-exames-modal table { width:100%; border-collapse:collapse; font-size:12px; }
        #susauto-exames-modal th { position:sticky; top:0; background:#f8fafc; color:#475569; text-align:left; font-weight:600; }
        #susauto-exames-modal th, #susauto-exames-modal td { padding:5px 8px; border-bottom:1px solid #f1f5f9; vertical-align:top; }
        #susauto-exames-modal td.data { white-space:nowrap; font-variant-numeric:tabular-nums; }
        #susauto-exames-modal td .cod { display:block; color:#94a3b8; font-size:11px; }
        #susauto-exames-modal tr.falta td.data { color:${UI.corNaoIdentificado}; font-weight:600; }
        #susauto-exames-modal tr.ignorar td { opacity:.4; text-decoration:line-through; }
        #susauto-exames-modal td input[type=checkbox] { cursor:pointer; }
        #susauto-exames-modal .vazio { padding:14px; color:#94a3b8; text-align:center; }
        #susauto-exames-modal .rodape { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        #susauto-exames-modal .info { color:#64748b; font-size:12px; }
        #susauto-exames-modal .acoes { display:flex; gap:8px; }
        #susauto-exames-modal .acoes button { height:34px; padding:0 14px; border:1px solid #d1d5db; border-radius:8px; background:#fff;
            color:#1f3a5f; font-weight:600; cursor:pointer; }
        #susauto-exames-modal .acoes .inserir { border:0; background:#1d4ed8; color:#fff; }
        #susauto-exames-modal .acoes button:disabled { opacity:.5; cursor:not-allowed; }

        #susauto-fila-modal { position:fixed; inset:0; z-index:2147483640; display:none; align-items:center;
            justify-content:center; background:rgba(15,23,42,.35); font:13px/1.4 system-ui,sans-serif; }
        #susauto-fila-modal.show { display:flex; }
        #susauto-fila-modal .card { display:flex; flex-direction:column; gap:10px; width:min(440px, calc(100vw - 32px));
            padding:16px; border-radius:12px; background:#fff; color:#1f2937; box-shadow:0 12px 40px rgba(0,0,0,.25); }
        #susauto-fila-modal .topo { display:flex; justify-content:space-between; align-items:center; font-size:15px; color:#1f3a5f; }
        #susauto-fila-modal .x { border:0; background:none; color:#64748b; font-size:22px; line-height:1; cursor:pointer; }
        #susauto-fila-modal .ajuda { margin:0; color:#475569; }
        #susauto-fila-modal textarea { height:220px; resize:vertical; padding:8px; border:1px solid #d1d5db; border-radius:8px;
            font:13px/1.5 ui-monospace,Consolas,monospace; }
        #susauto-fila-modal .rodape { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        #susauto-fila-modal .info { color:#64748b; font-size:12px; }
        #susauto-fila-modal .iniciar { height:34px; padding:0 18px; border:0; border-radius:8px; background:#1d4ed8;
            color:#fff; font-weight:600; cursor:pointer; }
        #susauto-fila-modal .iniciar:disabled { opacity:.5; cursor:not-allowed; }
        /* Rodando: vira um cartão pequeno no canto para a tela continuar visível */
        #susauto-fila-modal.rodando { background:transparent; pointer-events:none; align-items:flex-end; justify-content:flex-end; padding:16px; }
        #susauto-fila-modal.rodando .card { width:300px; pointer-events:auto; }
        #susauto-fila-modal.rodando textarea, #susauto-fila-modal.rodando .ajuda { display:none; }
        #susauto-fila-modal.rodando .iniciar { background:#b91c1c; }

        #susauto-erros { position:fixed; top:76px; right:16px; z-index:2147483645; display:none;
            width:min(460px, calc(100vw - 32px)); max-height:60vh; overflow:auto; background:#fff; color:#1f2937;
            border:1px solid #fecaca; border-left:4px solid #dc2626; border-radius:10px;
            box-shadow:0 8px 24px rgba(0,0,0,.18); font:13px/1.45 system-ui,sans-serif; }
        #susauto-erros.show { display:block; }
        #susauto-erros .cab { position:sticky; top:0; display:flex; justify-content:space-between; align-items:center; gap:8px;
            padding:8px 12px; background:#fff; border-bottom:1px solid #fee2e2; color:#b91c1c; font-weight:600; }
        #susauto-erros .cab button { border:0; background:none; color:#64748b; font-size:20px; line-height:1; cursor:pointer; }
        #susauto-erros ul { margin:0; padding:6px 12px 10px; list-style:none; }
        #susauto-erros li { padding:2px 0; font-variant-numeric:tabular-nums; }
    `;
    document.head.appendChild(css);

    let trabalhos = 0;
    let ultimoAviso = '';

    function statusBotao() {
        return document.getElementById('susauto-status');
    }

    function atualizarStatus(aviso) {
        const b = statusBotao();
        if (aviso !== undefined) ultimoAviso = aviso;
        if (!b) return;
        const st = trabalhos > 0 ? 'working' : (ultimoAviso ? 'warn' : 'listening');
        b.dataset.st = st;
        b.title = st === 'working' ? 'Automação: trabalhando…'
            : st === 'warn' ? 'Automação: última execução com pendências (clique para ver)\n' + ultimoAviso
            : 'Automação: ouvindo (pronto)';
        b.title += `\nVersão ${VERSAO}`;
    }

    // Envolve qualquer automação: anima o indicador enquanto roda
    async function trabalhar(nome, fn) {
        trabalhos++;
        atualizarStatus();
        const inicio = Date.now();
        try {
            return await fn();
        } catch (e) {
            LOG('Erro em', nome, e);
            avisar(`Erro em ${nome}: ${e.message}`, 'erro');
        } finally {
            const resto = 600 - (Date.now() - inicio); // mantém vermelho visível ao menos 600 ms
            if (resto > 0) await sleep(resto);
            trabalhos--;
            atualizarStatus();
        }
    }

    function avisar(msg, tipo = 'ok') {
        let t = document.getElementById('susauto-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'susauto-toast';
            document.body.appendChild(t);
        }
        t.style.background = tipo === 'ok' ? '#15803d' : tipo === 'aviso' ? '#b45309' : '#b91c1c';
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._h);
        t._h = setTimeout(() => t.classList.remove('show'), tipo === 'ok' ? 3000 : 8000);
    }

    /* =====================================================================
     * BARRA SUPERIOR: status + Atendimentos + ViverBem
     * ===================================================================== */
    function documentoPaciente() {
        // Procura os rótulos "CPF" e "CNS" do cabeçalho do atendimento
        const spans = [...document.querySelectorAll('main span')];
        const valorDe = (rot) => {
            const s = spans.find((e) => texto(e) === rot);
            const v = s?.nextElementSibling ? texto(s.nextElementSibling).replace(/\D/g, '') : '';
            return v.length >= 11 ? v : '';
        };
        return valorDe('CPF') || valorDe('CNS');
    }

    function montarBarra() {
        let bar = document.getElementById('susauto-bar');
        const sino = document.querySelector('header button[aria-label="Notificações"]');
        const alvo = sino?.parentElement;

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'susauto-bar';

            const st = document.createElement('button');
            st.id = 'susauto-status';
            st.type = 'button';
            st.innerHTML = '<span class="dot"></span>';
            st.addEventListener('click', () => {
                if (ultimoAviso) avisar(ultimoAviso, 'aviso');
                else avisar('Automação ouvindo. Use os atalhos do AHK no SOAP.', 'ok');
                ultimoAviso = '';
                atualizarStatus();
            });

            const lista = document.createElement('button');
            lista.id = 'susauto-lista';
            lista.type = 'button';
            lista.textContent = '☰ Atendimentos';
            lista.title = 'Voltar para a lista de atendimentos';
            lista.addEventListener('click', () => { location.href = CFG.urlListaAtendimentos; });

            const vb = document.createElement('button');
            vb.id = 'susauto-viverbem';
            vb.type = 'button';
            vb.textContent = '↗ ViverBem';
            vb.addEventListener('click', () => {
                const doc = documentoPaciente();
                if (doc) window.open(CFG.urlViverBem + doc, '_blank', 'noopener');
            });

            const fila = document.createElement('button');
            fila.id = 'susauto-fila';
            fila.type = 'button';
            // Ícone "pessoa com +"
            fila.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
                + ' stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
                + '<circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>'
                + 'Adicionar na fila';
            fila.addEventListener('click', abrirModalFila);

            const ex = document.createElement('button');
            ex.id = 'susauto-exames';
            ex.type = 'button';
            ex.textContent = '🧪 Exames';
            ex.title = 'Lançar resultados de exames a partir do texto (Objetivo)';
            ex.addEventListener('click', abrirModalExames);

            bar.append(st, lista, fila, ex, vb);
            atualizarStatus();
        }

        // Insere antes do sino (entre o nome da USF e as notificações); sem header, flutua
        if (alvo) {
            if (bar.parentElement !== alvo) alvo.insertBefore(bar, alvo.firstChild);
            bar.classList.remove('flutuante');
        } else if (!bar.isConnected) {
            bar.classList.add('flutuante');
            document.body.appendChild(bar);
        }

        // ViverBem e Exames só dentro do atendimento; "Adicionar na fila" só na lista de atendimentos
        const noAtendimento = reAtendimento.test(location.pathname);
        const vb = document.getElementById('susauto-viverbem');
        const doc = documentoPaciente();
        vb.hidden = !noAtendimento;
        vb.disabled = !doc;
        vb.title = doc ? `Abrir no ViverBem (${doc})` : 'Aguardando os dados do paciente';
        document.getElementById('susauto-exames').hidden = !noAtendimento;

        const fila = document.getElementById('susauto-fila');
        fila.hidden = !naListaAtendimentos() && !filaRodando;
        fila.title = `Adicionar vários cidadãos (CPF/CNS) na fila como "${CFG.tipoServicoFila}"`;

        if (UI.barraFixa) fixarBarra();
        ajustarBotaoUsf();
        linhaPaciente(noAtendimento);
    }

    // O <header> já é sticky, mas os contêineres acima dele têm overflow:hidden, o que anula o sticky.
    // overflow:clip corta igual, porém não cria área de rolagem, e o sticky volta a funcionar
    function fixarBarra() {
        const h = document.querySelector('header');
        for (let e = h?.parentElement; e && e !== document.body; e = e.parentElement) {
            if (e.dataset.susautoClip) continue;
            const s = getComputedStyle(e);
            if (s.overflowY === 'hidden' || s.overflowX === 'hidden') {
                e.style.overflow = 'clip';
                e.dataset.susautoClip = '1';
            }
        }
    }

    // Botão da lotação (USF): UI.escalaBotaoUsf do tamanho original, centralizado entre o breadcrumb e a barra
    let usfLarguraOriginal = 0;
    window.addEventListener('resize', () => { usfLarguraOriginal = 0; });

    function ajustarBotaoUsf() {
        const bar = document.getElementById('susauto-bar');
        const header = bar?.closest('header');
        const usf = header?.querySelector('button[class*="left-1/2"]');
        if (!usf || !usf.offsetParent) return;
        if (!usfLarguraOriginal) { // largura definida pelo sistema (muda com o tamanho da janela)
            usf.style.width = '';
            usf.style.left = '';
            usfLarguraOriginal = usf.getBoundingClientRect().width;
        }
        const pai = usf.offsetParent.getBoundingClientRect();
        const fim = bar.getBoundingClientRect().left - UI.folgaBotaoUsf;
        const desejada = usfLarguraOriginal * UI.escalaBotaoUsf;
        const migalha = header.querySelector('.text-muted-foreground'); // breadcrumb "Início > Atendimento > ..."
        let ini = pai.left + 16;
        if (migalha?.offsetWidth) {
            // Sem espaço: encurta o breadcrumb (os itens já têm reticências) até caber UI.larguraMinimaUsf
            const minima = Math.min(desejada, UI.larguraMinimaUsf);
            const r = migalha.getBoundingClientRect();
            const sobra = fim - r.right - UI.folgaBotaoUsf;
            if (sobra < minima) migalha.style.maxWidth = Math.max(0, r.width - (minima - sobra)) + 'px';
            else if (migalha.style.maxWidth && sobra > desejada + 40) migalha.style.maxWidth = '';
            ini = migalha.getBoundingClientRect().right + UI.folgaBotaoUsf;
        }
        const largura = Math.max(0, Math.min(desejada, fim - ini));
        usf.style.width = largura + 'px';
        usf.style.left = ((ini + fim) / 2 - pai.left) + 'px';
    }

    // "MALVACY SENA DA SILVA (44a)" sob a barra quando o cabeçalho do paciente rola para fora da tela
    function idadeCurta(t) {
        const m = t.match(/^(\d+)\s*(ano|m[eê]s|dia)/i);
        if (!m) return '';
        return m[1] + ({ a: 'a', m: 'm', d: 'd' })[m[2][0].toLowerCase()];
    }

    function linhaPaciente(noAtendimento) {
        const header = document.querySelector('header');
        if (!header) return;
        let linha = document.getElementById('susauto-paciente');
        if (!linha) {
            linha = document.createElement('div');
            linha.id = 'susauto-paciente';
        }
        if (linha.parentElement !== header) header.appendChild(linha);
        const idade = noAtendimento && [...document.querySelectorAll('main span')]
            .find((s) => s.children.length === 0 && /^\d+\s*(anos?|m[eê]s|meses|dias?)\b/i.test(texto(s)));
        const nome = idade?.previousElementSibling;
        if (!nome) { linha.classList.remove('show'); return; }
        const rotulo = `${texto(nome)} (${idadeCurta(texto(idade))})`;
        if (linha.textContent !== rotulo) {
            linha.replaceChildren(document.createElement('span'));
            linha.firstChild.textContent = rotulo;
        }
        // Alinha com o centro do botão da USF (se ele estiver visível)
        const usf = header.querySelector('button[class*="left-1/2"]');
        const r = usf?.offsetParent && usf.getBoundingClientRect();
        if (r?.width) linha.style.setProperty('--centro', (r.left + r.width / 2 - header.getBoundingClientRect().left) + 'px');
        else linha.style.removeProperty('--centro');
        linha.classList.toggle('show', nome.getBoundingClientRect().bottom < header.getBoundingClientRect().bottom);
    }

    /* =====================================================================
     * ABAS E SEÇÕES DO ATENDIMENTO
     * ===================================================================== */
    const abaSoap = () => document.querySelector('[role=tab][id$="-trigger-soap"]');
    const soapAtivo = () => abaSoap()?.getAttribute('data-state') === 'active';

    async function garantirSoap() {
        const aba = await esperar(abaSoap, 5000);
        if (!aba) throw new Error('aba SOAP não encontrada');
        if (!soapAtivo()) {
            clicar(aba);
            await esperar(soapAtivo, 3000);
            await sleep(300);
        }
    }

    // Botão de cabeçalho de seção ("Subjetivo", "Antecedentes", ...) — expande se recolhida
    async function expandirSecao(nome) {
        const re = new RegExp('^[A-Z]?' + nome + '$');
        const b = await esperar(() => [...document.querySelectorAll('main button[aria-expanded]')].find((x) => re.test(texto(x))), 4000);
        if (b && b.getAttribute('aria-expanded') === 'false') {
            clicar(b);
            await sleep(250);
        }
    }

    async function recolherAntecedentes() {
        const b = await esperar(() => [...document.querySelectorAll('main button[aria-expanded]')].find((x) => texto(x) === 'Antecedentes'), 4000);
        if (b && b.getAttribute('aria-expanded') === 'true') {
            const chevron = b.parentElement.querySelector('button[aria-label="Recolher"]') || b;
            clicar(chevron);
            LOG('Antecedentes recolhido');
            return true;
        }
        return false;
    }

    async function marcarTipoAtendimento() {
        const radios = await esperar(() => {
            const r = [...document.querySelectorAll('button[role=radio][id^="tipo-"]')];
            return r.length ? r : null;
        }, 5000);
        if (!radios) return false;
        if (radios.some((r) => r.getAttribute('data-state') === 'checked')) return false;
        for (const id of CFG.tiposAtendimento) {
            const r = document.getElementById(id);
            if (r && !r.disabled) {
                clicar(r);
                LOG('Tipo de atendimento marcado:', id);
                return true;
            }
        }
        return false;
    }

    // Rola todos os contêineres para o topo e deixa o cursor no Subjetivo
    async function focarSubjetivo() {
        await expandirSecao(SECOES.subjetivo);
        const ta = await esperar(() => [...document.querySelectorAll('textarea')].find((t) => t.placeholder.startsWith(CAMPOS.subjetivo)), 3000);
        for (let e = ta?.parentElement; e; e = e.parentElement) {
            if (e.scrollTop > 0) e.scrollTop = 0;
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (ta) {
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }

    /* =====================================================================
     * PREENCHIMENTO
     * ===================================================================== */
    async function escreverCampo(chave, valor) {
        if (!valor) return;
        await expandirSecao(SECOES[chave]);
        const ta = await esperar(() => [...document.querySelectorAll('textarea')].find((t) => t.placeholder.startsWith(CAMPOS[chave])), 4000);
        if (!ta) throw new Error(`campo ${SECOES[chave]} não encontrado`);
        const atual = ta.value.replace(/\s+$/, '');
        if (atual.includes(valor.trim())) return; // já preenchido: não duplica
        definirValor(ta, atual ? atual + '\n' + valor : valor);
    }

    // Abre um combobox pesquisável, busca o código e clica na opção correspondente
    async function selecionarNoCombobox(combo, codigo) {
        clicar(combo);
        const pop = await esperar(() => {
            const id = combo.getAttribute('aria-controls');
            const lb = id && document.getElementById(id);
            return lb?.closest('[data-radix-popper-content-wrapper]')
                || [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].pop();
        }, 3000);
        if (!pop) throw new Error('lista não abriu');

        const busca = pop.querySelector('input');
        if (busca) definirValor(busca, codigo);

        // SIGTAP vem como "CÓDIGO - DESCRIÇÃO"; CID 10 como "DESCRIÇÃO - CÓDIGO"
        const opcao = await esperar(() => [...pop.querySelectorAll('[role=option]')]
            .find((o) => textoTemCodigo(texto(o), codigo)), CFG.timeoutBusca, 150);

        if (!opcao) {
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(200);
            return false;
        }
        clicar(opcao);
        await esperar(() => !pop.isConnected, 2000);
        await sleep(250);
        return true;
    }

    // Intervenções e/ou Procedimentos clínicos realizados → acordeão "CIAP 2" ou "SIGTAP"
    async function adicionarIntervencoes(tipo, codigos) {
        if (!codigos?.length) return [];
        await expandirSecao('Plano');
        const h3 = await esperar(() => [...document.querySelectorAll('h3')].find((h) => texto(h).startsWith('Intervenções')), 4000);
        if (!h3) throw new Error('seção Intervenções não encontrada');
        const caixa = h3.parentElement;
        const reTitulo = new RegExp('^' + tipo.replace(' ', '\\s?'));
        const acordeao = botaoPorTexto(caixa, reTitulo);
        if (!acordeao) throw new Error(`acordeão ${tipo} não encontrado`);
        if (acordeao.getAttribute('aria-expanded') !== 'true') {
            clicar(acordeao);
            await sleep(300);
        }
        // sobe a partir do acordeão até achar o bloco que contém o combobox
        let bloco = acordeao.parentElement;
        while (bloco && bloco !== caixa && !bloco.querySelector('[role=combobox]')) bloco = bloco.parentElement;
        if (!bloco || bloco === caixa) throw new Error(`campo ${tipo} não encontrado`);

        const falhas = [];
        for (const c of codigos) {
            if (jaAdicionado(bloco, c)) continue;
            const combo = bloco.querySelector('[role=combobox]');
            const ok = await selecionarNoCombobox(combo, c);
            if (!ok) falhas.push(`${tipo} ${c}`);
        }
        return falhas;
    }

    // Avaliação → "Problemas e/ou condições avaliados neste atendimento"
    async function adicionarProblemas(rotulo, codigos) {
        if (!codigos?.length) return [];
        await expandirSecao('Avaliação');
        const fs = await esperar(() => [...document.querySelectorAll('fieldset')].find((f) => texto(f.querySelector('legend')).startsWith('Problemas e/ou condições avaliados')), 4000);
        if (!fs) throw new Error('bloco de Problemas/condições não encontrado');

        const falhas = [];
        for (const c of codigos) {
            if (jaAdicionado(fs, c)) continue;
            const lbl = [...fs.querySelectorAll('label')].find((l) => texto(l) === rotulo);
            const combo = lbl?.parentElement.querySelector('[role=combobox]');
            if (!combo) { falhas.push(`${rotulo} ${c}`); continue; }
            const ok = await selecionarNoCombobox(combo, c);
            if (!ok) { falhas.push(`${rotulo} ${c}`); continue; }
            const add = await esperar(() => {
                const b = botaoPorTexto(fs, /^Adicionar$/);
                return b && !b.disabled ? b : null;
            }, 2000);
            if (add) { clicar(add); await sleep(400); }
        }
        return falhas;
    }

    async function marcarCheckboxes(rotulos) {
        const falhas = [];
        for (const r of rotulos || []) {
            const lbl = [...document.querySelectorAll('main label')].find((l) => texto(l) === r);
            const cb = lbl && (lbl.querySelector('button[role=checkbox]') || lbl.parentElement.querySelector('button[role=checkbox]'));
            if (!cb) { falhas.push(`marcar "${r}"`); continue; }
            if (cb.getAttribute('data-state') !== 'checked') { clicar(cb); await sleep(150); }
        }
        return falhas;
    }

    async function definirDesfecho(desfecho) {
        if (!desfecho) return [];
        const id = desfecho === 'liberar' ? 'desfecho-liberar' : desfecho === 'manter' ? 'desfecho-manter-lista' : desfecho;
        const r = await esperar(() => document.getElementById(id), 3000);
        if (!r) return [`desfecho ${desfecho}`];
        if (r.getAttribute('data-state') !== 'checked') clicar(r);
        return [];
    }

    /*
     * Formato do JSON enviado pelo AHK (todos os campos são opcionais):
     * {
     *   "subjetivo": "texto",  "objetivo": "texto",  "avaliacao": "texto",  "plano": "texto",
     *   "cid10": ["D21"],                 // Avaliação > Problemas/condições (CID 10)
     *   "ciapAvaliacao": ["S99"],         // Avaliação > Problemas/condições (CIAP 2)
     *   "ciap": ["30"],                   // Plano > Intervenções > CIAP 2
     *   "sigtap": ["0301010064"],         // Plano > Intervenções > SIGTAP
     *   "marcar": ["Alta do episódio"],   // checkboxes da Conduta (texto exato do rótulo)
     *   "desfecho": "liberar"             // "liberar" | "manter"
     * }
     */
    async function aplicar(d) {
        await garantirSoap();
        const falhas = [];
        for (const k of ['subjetivo', 'objetivo', 'avaliacao']) {
            try { await escreverCampo(k, d[k]); } catch (e) { falhas.push(e.message); }
        }
        falhas.push(...await adicionarProblemas('CIAP 2', d.ciapAvaliacao));
        falhas.push(...await adicionarProblemas('CID 10', d.cid10));
        try { await escreverCampo('plano', d.plano); } catch (e) { falhas.push(e.message); }
        falhas.push(...await adicionarIntervencoes('CIAP 2', d.ciap));
        falhas.push(...await adicionarIntervencoes('SIGTAP', d.sigtap));
        if (CFG.marcarTipoAtendimento) await marcarTipoAtendimento();
        falhas.push(...await marcarCheckboxes(d.marcar));
        falhas.push(...await definirDesfecho(d.desfecho));

        if (falhas.length) {
            const msg = 'Preenchido com pendências:\n• ' + falhas.join('\n• ');
            avisar(msg, 'aviso');
            atualizarStatus(msg);
        } else {
            avisar('SOAP preenchido. Revise e finalize manualmente.', 'ok');
            atualizarStatus('');
        }
        LOG('Template aplicado', d, 'falhas:', falhas);
    }

    /* =====================================================================
     * FILA DE RECEPÇÃO: adiciona vários cidadãos (CPF/CNS) de uma vez
     * ===================================================================== */
    const naListaAtendimentos = () => location.pathname.replace(/\/$/, '') === '/atendimento/lista-atendimentos';

    function cpfValido(d) {
        if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
        for (const n of [9, 10]) {
            let soma = 0;
            for (let i = 0; i < n; i++) soma += +d[i] * (n + 1 - i);
            if ((soma * 10) % 11 % 10 !== +d[n]) return false;
        }
        return true;
    }

    // CNS definitivo (1/2) e provisório (7/8/9): soma ponderada (pesos 15..1) múltipla de 11
    function cnsValido(d) {
        if (!/^[12789]\d{14}$/.test(d)) return false;
        let soma = 0;
        for (let i = 0; i < 15; i++) soma += +d[i] * (15 - i);
        return soma % 11 === 0;
    }

    const formatarDoc = (d) => d.length === 11
        ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
        : d.replace(/(\d{3})(\d{4})(\d{4})(\d{4})/, '$1 $2 $3 $4');

    const formatarDocs = (docs) => docs.map(formatarDoc).join(' + ');

    // Documentos de uma linha: um CPF, um CNS, ou os dois (da mesma pessoa) em qualquer ordem
    function documentosDaLinha(original) {
        const d = original.replace(/\D/g, '');
        if (d.length === 11) return cpfValido(d) ? { docs: [d] } : { erro: 'CPF inválido' };
        if (d.length === 15) return cnsValido(d) ? { docs: [d] } : { erro: 'CNS inválido' };
        if (d.length === 26) {
            // Separador pode ser espaço (que também aparece na máscara do CNS): vale a ordem cujos
            // dois números fecham os dígitos verificadores
            const ordens = [{ cpf: d.slice(0, 11), cns: d.slice(11) }, { cns: d.slice(0, 15), cpf: d.slice(15) }];
            const ok = ordens.find((o) => cpfValido(o.cpf) && cnsValido(o.cns));
            if (ok) return { docs: Object.values(ok) };
            const meio = ordens.find((o) => cpfValido(o.cpf) || cnsValido(o.cns));
            return { erro: !meio ? 'CPF e CNS inválidos' : cpfValido(meio.cpf) ? 'CNS inválido' : 'CPF inválido' };
        }
        return { erro: 'esperado CPF (11 dígitos), CNS (15) ou CPF + CNS na mesma linha' };
    }

    // Uma linha por cidadão; guarda a posição da linha para as mensagens de erro
    function lerDocumentos(textoLinhas) {
        const validos = [], erros = [], vistos = new Map();
        textoLinhas.split(/\r?\n/).forEach((bruto, i) => {
            const linha = i + 1;
            const original = bruto.trim();
            if (!original) return;
            const { docs, erro } = documentosDaLinha(original);
            const repetido = docs?.find((d) => vistos.has(d));
            if (erro) {
                erros.push({ linha, doc: original, msg: erro });
            } else if (repetido) {
                erros.push({ linha, doc: formatarDocs(docs), msg: `repetido (linha ${vistos.get(repetido)})` });
            } else {
                docs.forEach((d) => vistos.set(d, linha));
                validos.push({ linha, docs });
            }
        });
        return { validos, erros };
    }

    const formAdicaoAberto = () => document.querySelector('main label[for="tipo-servico"]');
    const comboDoCampo = (id) => document.querySelector(`main label[for="${id}"]`)?.parentElement.querySelector('[role=combobox]');
    const popoverAberto = () => [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].pop();
    const toastsSistema = () => [...document.querySelectorAll('[data-sonner-toast], li[data-type]')].map(texto);
    const dialogoSistema = () => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')]
        .find((d) => !d.closest('[data-radix-popper-content-wrapper], #susauto-fila-modal'));

    // Números inteiros do texto, aceitando máscara ("CPF 123.456.789-09CNS 898 0058…" → ['12345678909', '8980058…'])
    const numerosDoTexto = (s) => s.split(/[^\d.\-\s]+/).map((p) => p.replace(/\D/g, '')).filter(Boolean);

    async function fecharPopover() {
        if (!popoverAberto()) return;
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await esperar(() => !popoverAberto(), 1500);
    }

    async function cancelarAdicao() {
        await fecharPopover();
        const b = botaoPorTexto(document.querySelector('main'), /^Cancelar adição$/);
        if (b) { clicar(b); await esperar(() => !formAdicaoAberto(), 2000); }
    }

    // O resultado mostra algum dos documentos e nenhum outro CPF/CNS diferente dos digitados?
    function opcaoConfere(nums, docs) {
        if (!docs.some((d) => nums.includes(d))) return '';
        const conflito = docs.some((d) => {
            const mesmoTipo = nums.filter((n) => n.length === d.length);
            return mesmoTipo.length && !mesmoTipo.includes(d);
        });
        return conflito ? 'conflito' : 'ok';
    }

    // Busca no campo Cidadão (pelo 1º documento; se não achar, pelo 2º) e seleciona o resultado.
    // Devolve '' ou o motivo da falha
    async function selecionarCidadao(docs) {
        const combo = comboDoCampo('cidadao');
        if (!combo) throw new Error('campo Cidadão não encontrado');
        clicar(combo);
        const pop = await esperar(() => { const p = popoverAberto(); return p?.querySelector('input') ? p : null; }, 3000);
        if (!pop) throw new Error('busca de cidadão não abriu');

        for (const doc of docs) {
            definirValor(pop.querySelector('input'), doc);
            // "Nenhum resultado" pode aparecer antes de a busca responder: só vale se persistir
            const fim = Date.now() + CFG.timeoutBusca;
            let semResultadoDesde = 0;
            while (Date.now() < fim) {
                await sleep(150);
                const ops = [...pop.querySelectorAll('[role=option]')]
                    .map((o) => ({ o, r: opcaoConfere(numerosDoTexto(o.textContent), docs) }));
                const op = ops.find((x) => x.r === 'ok');
                if (op) {
                    clicar(op.o);
                    await esperar(() => !pop.isConnected, 2000);
                    return '';
                }
                const conflito = ops.find((x) => x.r === 'conflito');
                if (conflito) return `CPF e CNS não são da mesma pessoa (achado: ${texto(conflito.o).split(/CPF|CNS/)[0].trim()})`;
                if (/Nenhum resultado/i.test(texto(pop))) {
                    semResultadoDesde ||= Date.now();
                    if (Date.now() - semResultadoDesde > 2500) break;
                } else {
                    semResultadoDesde = 0;
                }
            }
        }
        return 'não encontrado';
    }

    async function marcarTipoServico(nome) {
        const combo = comboDoCampo('tipo-servico');
        if (!combo) throw new Error('campo Tipo de serviço não encontrado');
        if (texto(combo).includes(nome)) return;
        clicar(combo);
        const cb = await esperar(() => {
            const l = [...(popoverAberto()?.querySelectorAll('label') || [])].find((x) => texto(x) === nome);
            return l?.parentElement.querySelector('button[role=checkbox]');
        }, 3000);
        if (!cb) throw new Error(`tipo de serviço "${nome}" não encontrado`);
        if (cb.getAttribute('data-state') !== 'checked') clicar(cb);
        await esperar(() => cb.getAttribute('data-state') === 'checked', 1500);
        await fecharPopover();
    }

    // Um cidadão: abre o formulário, preenche e clica em Adicionar. Devolve '' ou o motivo da falha
    async function adicionarCidadao(docs) {
        if (formAdicaoAberto()) await cancelarAdicao();
        const abrir = botaoPorTexto(document.querySelector('main'), /^Adicionar cidadão$/);
        if (!abrir) return 'botão "Adicionar cidadão" não encontrado';
        clicar(abrir);
        if (!await esperar(formAdicaoAberto, 3000)) return 'formulário não abriu';
        try {
            const naoAchou = await selecionarCidadao(docs);
            if (naoAchou) return naoAchou;
            await marcarTipoServico(CFG.tipoServicoFila);
            const antes = new Set(toastsSistema());
            const add = await esperar(() => {
                const b = botaoPorTexto(document.querySelector('main'), /^Adicionar$/);
                return b && !b.disabled ? b : null;
            }, 2000);
            if (!add) return 'botão Adicionar indisponível';
            clicar(add);
            // Sucesso: aviso "Cidadão adicionado à fila..." e o formulário fecha; erro: aviso do sistema;
            // já na fila hoje: diálogo "Atendimento duplicado" → sempre Cancelar (nunca Prosseguir)
            const r = await esperar(() => toastsSistema().find((x) => !antes.has(x))
                || dialogoSistema() || (!formAdicaoAberto() && 'fechou'), 10000);
            if (!r) return 'sem resposta do sistema';
            if (r instanceof Element) {
                const msg = /duplicado/i.test(texto(r))
                    ? `já está na fila hoje (${texto(r).match(/LA-\d+/g)?.join(', ') || 'atendimento ativo'})`
                    : `sistema pediu confirmação: ${texto(r).slice(0, 120)}`;
                const cancelar = botaoPorTexto(r, /^Cancelar$/);
                if (cancelar) clicar(cancelar);
                await esperar(() => !r.isConnected, 2000);
                return msg;
            }
            if (r === 'fechou' || /adicionad/i.test(r)) {
                LOG('Fila:', formatarDocs(docs), r);
                return '';
            }
            return r;
        } finally {
            if (formAdicaoAberto()) await cancelarAdicao();
        }
    }

    function mostrarErros(erros, resumo) {
        let p = document.getElementById('susauto-erros');
        if (!p) {
            p = document.createElement('div');
            p.id = 'susauto-erros';
            p.setAttribute('role', 'alert');
            document.body.appendChild(p);
        }
        p.innerHTML = '<div class="cab"><span></span><button type="button" title="Fechar">×</button></div><ul></ul>';
        p.querySelector('.cab span').textContent = resumo;
        p.querySelector('.cab button').addEventListener('click', () => p.classList.remove('show'));
        const ul = p.querySelector('ul');
        for (const e of erros) {
            const li = document.createElement('li');
            li.textContent = `Linha ${e.linha} · ${e.doc} — ${e.msg}`;
            ul.appendChild(li);
        }
        p.classList.add('show');
        clearTimeout(p._h);
        p._h = setTimeout(() => p.classList.remove('show'), CFG.tempoErroMs);
    }

    let filaRodando = false;
    let filaParar = false;

    function modalFila() {
        let ov = document.getElementById('susauto-fila-modal');
        if (ov) return ov;
        ov = document.createElement('div');
        ov.id = 'susauto-fila-modal';
        ov.innerHTML = `
            <div class="card" role="dialog" aria-label="Adicionar na fila">
                <div class="topo"><b>Adicionar na fila</b><button type="button" class="x" title="Fechar">×</button></div>
                <p class="ajuda">Um cidadão por linha: CPF, CNS ou os dois (com ou sem pontuação).<br>Tipo de serviço: <b></b></p>
                <textarea spellcheck="false" placeholder="000.000.000-00&#10;898 0058 5446 0671"></textarea>
                <div class="rodape"><span class="info"></span><button type="button" class="iniciar">Iniciar</button></div>
            </div>`;
        ov.querySelector('.ajuda b').textContent = CFG.tipoServicoFila;
        const ta = ov.querySelector('textarea');
        const fechar = () => { if (!filaRodando) ov.classList.remove('show'); };
        ta.addEventListener('input', () => infoFila(ov));
        ov.querySelector('.x').addEventListener('click', () => { if (filaRodando) filaParar = true; else fechar(); });
        ov.querySelector('.iniciar').addEventListener('click', () => { if (filaRodando) filaParar = true; else executarFila(); });
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) fechar(); });
        ov.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') fechar();
            // Ctrl+Enter = Iniciar (não interrompe uma execução em andamento)
            if (e.key === 'Enter' && e.ctrlKey && !filaRodando) {
                e.preventDefault();
                const bt = ov.querySelector('.iniciar');
                if (!bt.disabled) bt.click();
            }
        });
        ov.querySelector('.iniciar').title = 'Ctrl+Enter';
        document.body.appendChild(ov);
        return ov;
    }

    function infoFila(ov, msg) {
        const info = ov.querySelector('.info');
        const bt = ov.querySelector('.iniciar');
        if (msg) { info.textContent = msg; return; }
        const { validos, erros } = lerDocumentos(ov.querySelector('textarea').value);
        info.textContent = validos.length || erros.length
            ? `${validos.length} válido(s)` + (erros.length ? ` · ${erros.length} com problema` : '') : '';
        bt.disabled = !validos.length;
    }

    function abrirModalFila() {
        const ov = modalFila();
        ov.classList.add('show');
        if (!filaRodando) infoFila(ov);
        ov.querySelector('textarea').focus();
    }

    async function executarFila() {
        const ov = modalFila();
        const ta = ov.querySelector('textarea');
        const bt = ov.querySelector('.iniciar');
        const { validos, erros } = lerDocumentos(ta.value);
        if (!validos.length) return;
        if (!naListaAtendimentos()) { avisar('Abra a lista de atendimentos para adicionar na fila.', 'erro'); return; }

        filaRodando = true;
        filaParar = false;
        ov.classList.add('rodando');
        bt.textContent = 'Parar';
        ta.readOnly = true;
        let ok = 0;
        await trabalhar('adicionar na fila', async () => {
            for (const [i, item] of validos.entries()) {
                if (filaParar || !naListaAtendimentos()) {
                    erros.push(...validos.slice(i).map((v) => ({ linha: v.linha, doc: formatarDocs(v.docs), msg: 'não processado (interrompido)' })));
                    break;
                }
                infoFila(ov, `${i + 1}/${validos.length} · ${formatarDocs(item.docs)}…`);
                let falha;
                try { falha = await adicionarCidadao(item.docs); } catch (e) { falha = e.message; }
                if (falha) erros.push({ linha: item.linha, doc: formatarDocs(item.docs), msg: falha });
                else ok++;
            }
        });
        filaRodando = false;
        ov.classList.remove('rodando', 'show');
        bt.textContent = 'Iniciar';
        ta.readOnly = false;

        erros.sort((a, b) => a.linha - b.linha);
        const resumo = `${ok} adicionado(s) na fila` + (erros.length ? ` · ${erros.length} com problema` : '');
        if (erros.length) {
            mostrarErros(erros, resumo);
            atualizarStatus(resumo + '\n' + erros.map((e) => `Linha ${e.linha} · ${e.doc} — ${e.msg}`).join('\n'));
        } else {
            avisar(resumo + '.', 'ok');
        }
        // Na caixa ficam só as linhas que não entraram, para corrigir e rodar de novo.
        // "Repetido" sai: a 1ª ocorrência já representa o cidadão (fica se ela falhou)
        const manter = new Set(erros.filter((e) => !e.msg.startsWith('repetido')).map((e) => e.linha));
        ta.value = ta.value.split(/\r?\n/).filter((_, i) => manter.has(i + 1)).join('\n');
        infoFila(ov);
    }

    /* =====================================================================
     * LISTA DE ATENDIMENTOS: switch "Ver somente meus atendimentos" filtra na hora
     * ===================================================================== */
    const switchMeus = () => document.getElementById('somente-meus');
    const botaoFiltrar = () => botaoPorTexto(document.querySelector('main') || document, /^Filtrar$/);

    // O switch só muda o formulário; a lista só é atualizada pelo botão Filtrar.
    // Vale para clique, teclado (Espaço gera click) e o clique do próprio script
    document.addEventListener('click', (ev) => {
        const sw = ev.target.closest?.('#somente-meus');
        if (!sw || !naListaAtendimentos()) return;
        const antes = sw.getAttribute('data-state');
        trabalhar('filtrar lista', async () => {
            // Espera o React aplicar o novo estado antes de enviar o filtro
            await esperar(() => sw.getAttribute('data-state') !== antes, 1500);
            const f = botaoFiltrar();
            if (f && !f.disabled) clicar(f);
        });
    }, true);

    // Chegou na lista sem "somente_meus" na URL (o sistema volta assim ao sair do atendimento):
    // marca o switch (o listener acima filtra). "somente_meus=false" é escolha do usuário e fica
    async function filtrarMeusAtendimentos() {
        if (new URLSearchParams(location.search).has('somente_meus')) return;
        const sw = await esperar(switchMeus, 5000);
        if (!sw || !naListaAtendimentos()) return;
        if (sw.getAttribute('data-state') === 'checked') {
            const f = await esperar(botaoFiltrar, 2000);
            if (f) clicar(f);
        } else {
            clicar(sw);
        }
        LOG('Lista: filtro "somente meus atendimentos" aplicado');
    }

    /* =====================================================================
     * EXAMES: dicionário (editável)
     * ---------------------------------------------------------------------
     * Cada linha: [código SIGTAP, nome mostrado na prévia, 'APELIDO|APELIDO|...'].
     * Apelidos em maiúsculas e sem acento; espaço e hífen são opcionais na digitação
     * ("USG TV" também reconhece "USGTV" e "USG-TV"). O código é o que é buscado no sistema.
     * ===================================================================== */
    const EXAMES = [
        // Bioquímica / metabólicos
        ['0202010473', 'GLICEMIA DE JEJUM', 'GLICOSE|GLICEMIA|GLICEMIA DE JEJUM|GLICEMIA JEJUM|GJ|GLI|GLIC'],
        ['0202010503', 'HEMOGLOBINA GLICOSILADA', 'HBA1C|HB A1C|A1C|HEMOGLOBINA GLICADA|HEMOGLOBINA GLICOSILADA|HB GLICADA|HB GLICOSILADA|GLICADA'],
        ['0202010295', 'COLESTEROL TOTAL', 'CT|COL TOTAL|COLESTEROL TOTAL|COLESTEROL|COL T'],
        ['0202010279', 'COLESTEROL HDL', 'HDL|HDL C|COLESTEROL HDL'],
        ['0202010287', 'COLESTEROL LDL', 'LDL|LDL C|COLESTEROL LDL'],
        ['0202010678', 'TRIGLICERÍDEOS', 'TG|TGL|TRIG|TRIGLICERIDEOS|TRIGLICERIDES|TRIGLICERIDIOS'],
        ['0202010317', 'CREATININA', 'CREATININA|CREAT|CREA|CR'],
        ['0202010694', 'UREIA', 'UREIA|UR'],
        ['0202010120', 'ÁCIDO ÚRICO', 'AU|AC URICO|ACIDO URICO|AC UR'],
        ['0202010643', 'TGO', 'TGO|AST|TGO AST'],
        ['0202010651', 'TGP', 'TGP|ALT|TGP ALT'],
        ['0202010465', 'GAMA GT', 'GGT|GAMA GT|GAMAGT|GAMA GLUTAMIL TRANSFERASE'],
        ['0202010422', 'FOSFATASE ALCALINA', 'FA|FAL|FOSFATASE ALCALINA'],
        ['0202010201', 'BILIRRUBINA TOTAL E FRAÇÕES', 'BT|BILI|BILIRRUBINA|BILIRRUBINAS|BILIRRUBINA TOTAL|BILIRRUBINAS TOTAIS E FRACOES'],
        ['0202010600', 'POTÁSSIO', 'K|POTASSIO'],
        ['0202010635', 'SÓDIO', 'NA|SODIO'],
        ['0202010210', 'CÁLCIO', 'CA|CALCIO|CALCIO TOTAL'],
        ['0202010228', 'CÁLCIO IÔNICO', 'CAI|CA IONICO|CALCIO IONICO|CALCIO IONIZAVEL'],
        ['0202010562', 'MAGNÉSIO', 'MG|MAGNESIO'],
        ['0202010430', 'FÓSFORO', 'FOSFORO|FOSF'],
        ['0202010384', 'FERRITINA', 'FERRITINA|FERRIT'],
        ['0202010392', 'FERRO SÉRICO', 'FERRO|FE|FERRO SERICO'],
        ['0202010660', 'TRANSFERRINA', 'TRANSFERRINA'],
        ['0202010406', 'ÁCIDO FÓLICO', 'FOLATO|ACIDO FOLICO|AC FOLICO'],
        ['0202010708', 'VITAMINA B12', 'B12|VIT B12|VITAMINA B12|CIANOCOBALAMINA'],
        ['0202010767', 'VITAMINA D', 'VITD|VIT D|VITAMINA D|VIT D3|25OH|25 OH VIT D|25 HIDROXIVITAMINA D'],
        ['0202010619', 'PROTEÍNAS TOTAIS', 'PROTEINAS TOTAIS|PROT TOTAIS'],
        ['0202010627', 'PROTEÍNAS TOTAIS E FRAÇÕES', 'ALBUMINA|ALB|PROTEINAS TOTAIS E FRACOES'],
        ['0202010180', 'AMILASE', 'AMILASE'],
        ['0202010554', 'LIPASE', 'LIPASE'],
        ['0202010325', 'CPK', 'CPK|CK'],
        ['0202030202', 'PROTEÍNA C REATIVA', 'PCR|PROTEINA C REATIVA|PCR US'],
        ['0202020150', 'VHS', 'VHS|VSG|HEMOSSEDIMENTACAO'],
        ['0202020142', 'TAP / INR', 'TAP|TP|INR|RNI|TEMPO DE PROTROMBINA'],
        ['0202020134', 'TTPA', 'TTPA|KTTP|TTP'],
        ['0202020037', 'RETICULÓCITOS', 'RETICULOCITOS|RETIC'],
        // Hemograma
        ['0202020380', 'HEMOGRAMA COMPLETO', 'HEMOGRAMA|HEMOGRAMA COMPLETO|HMG'],
        // Hormônios
        ['0202060250', 'TSH', 'TSH'],
        ['0202060381', 'T4 LIVRE', 'T4L|T4 LIVRE|FT4'],
        ['0202060373', 'T4 TOTAL', 'T4|T4 TOTAL'],
        ['0202060390', 'T3', 'T3|T3 TOTAL'],
        ['0202060276', 'PTH', 'PTH|PARATORMONIO'],
        ['0202060136', 'CORTISOL', 'CORTISOL'],
        ['0202060160', 'ESTRADIOL', 'E2|ESTRADIOL'],
        ['0202060233', 'FSH', 'FSH'],
        ['0202060241', 'LH', 'LH'],
        ['0202060306', 'PROLACTINA', 'PRL|PROLACTINA'],
        ['0202060349', 'TESTOSTERONA', 'TESTOSTERONA|TESTOSTERONA TOTAL'],
        ['0202060357', 'TESTOSTERONA LIVRE', 'TESTOSTERONA LIVRE'],
        ['0202060268', 'INSULINA', 'INSULINA|INSULINEMIA'],
        ['0202060217', 'BETA HCG', 'BHCG|BETA HCG|BETAHCG|HCG'],
        ['0202030105', 'PSA', 'PSA|PSA TOTAL|ANTIGENO PROSTATICO'],
        // Urina e fezes
        ['0202050017', 'EAS (URINA TIPO 1)', 'EAS|URINA 1|URINA I|URINA TIPO 1|SUMARIO DE URINA|SU|EQU|URINALISE'],
        ['0202080080', 'UROCULTURA', 'UROCULTURA|URC|CULTURA DE URINA'],
        ['0202050092', 'MICROALBUMINÚRIA', 'MICROALBUMINURIA|MICROALBUMINA|MALB|RAC|RELACAO ALBUMINA CREATININA'],
        ['0202050114', 'PROTEINÚRIA DE 24 HORAS', 'PROTEINURIA|PROTEINURIA 24H|PROTEINURIA DE 24 HORAS'],
        ['0202040143', 'SANGUE OCULTO NAS FEZES', 'SOF|PSOF|SANGUE OCULTO|SANGUE OCULTO NAS FEZES'],
        // Sorologias e testes rápidos
        ['0202031500', 'HIV (SOROLOGIA)', 'HIV|ANTI HIV|SOROLOGIA HIV'],
        ['0202031470', 'ANTI-HCV', 'ANTI HCV|HCV|HEPATITE C'],
        ['0202031446', 'HBSAG', 'HBSAG|HBS AG|HEPATITE B'],
        ['0202030636', 'ANTI-HBS', 'ANTI HBS|ANTIHBS'],
        ['0202031110', 'VDRL', 'VDRL|SIFILIS'],
        ['0202030768', 'TOXOPLASMOSE IGG', 'TOXO IGG|TOXOPLASMOSE IGG'],
        ['0202030873', 'TOXOPLASMOSE IGM', 'TOXO IGM|TOXOPLASMOSE IGM'],
        ['0202030814', 'RUBÉOLA IGG', 'RUBEOLA IGG'],
        ['0202030920', 'RUBÉOLA IGM', 'RUBEOLA IGM'],
        ['0214010058', 'TESTE RÁPIDO HIV', 'TR HIV|TESTE RAPIDO HIV'],
        ['0214010074', 'TESTE RÁPIDO SÍFILIS', 'TR SIFILIS|TESTE RAPIDO SIFILIS'],
        ['0214010228', 'TESTE RÁPIDO HEPATITE B', 'TR HBSAG|TR HEPATITE B|TR HBV|TESTE RAPIDO HEPATITE B'],
        ['0214010066', 'TESTE RÁPIDO DE GRAVIDEZ', 'TRG|TR GRAVIDEZ|TESTE DE GRAVIDEZ|TESTE RAPIDO DE GRAVIDEZ'],
        ['0202080048', 'BACILOSCOPIA (BAAR)', 'BAAR|BACILOSCOPIA'],
        // Outros exames (sem região)
        ['0211020036', 'ELETROCARDIOGRAMA', 'ECG|ELETROCARDIOGRAMA'],
        ['0205010032', 'ECOCARDIOGRAMA TRANSTORÁCICO', 'ECO|ECOTT|ECOCARDIOGRAMA|ECOCARDIOGRAMA TRANSTORACICO'],
        ['0211020044', 'HOLTER 24H', 'HOLTER|HOLTER 24H'],
        ['0211020052', 'MAPA', 'MAPA|MAPA 24H'],
        ['0211020060', 'TESTE ERGOMÉTRICO', 'TE|TESTE ERGOMETRICO|ERGOMETRIA|TESTE DE ESFORCO'],
        ['0211080055', 'ESPIROMETRIA', 'ESPIROMETRIA|PFP|PROVA DE FUNCAO PULMONAR'],
        ['0204030188', 'MAMOGRAFIA BILATERAL (RASTREAMENTO)', 'MMG|MAMO|MAMOGRAFIA|MAMOGRAFIA BILATERAL'],
        ['0204030030', 'MAMOGRAFIA (DIAGNÓSTICA)', 'MAMOGRAFIA DIAGNOSTICA|MMG DIAGNOSTICA'],
        ['0204060028', 'DENSITOMETRIA ÓSSEA', 'DMO|DENSITOMETRIA|DENSITOMETRIA OSSEA'],
        ['0209010037', 'ENDOSCOPIA DIGESTIVA ALTA', 'EDA|ENDOSCOPIA|ENDOSCOPIA DIGESTIVA ALTA|ESOFAGOGASTRODUODENOSCOPIA'],
        ['0209010029', 'COLONOSCOPIA', 'COLONO|COLONOSCOPIA'],
        ['0203010086', 'CITOPATOLÓGICO DO COLO (RASTREAMENTO)', 'CCO|PREVENTIVO|PAPANICOLAU|CITOPATOLOGICO|CITOLOGIA ONCOTICA|COLPOCITOLOGIA'],
        ['0211050040', 'ELETROENCEFALOGRAMA', 'EEG|ELETROENCEFALOGRAMA'],
        ['0211060020', 'FUNDO DE OLHO', 'FO|FUNDO DE OLHO|FUNDOSCOPIA|MAPEAMENTO DE RETINA'],
    ];

    // Itens do hemograma: viram UMA linha "HEMOGRAMA COMPLETO" com o resultado "HB 12,3 · HT 38 · ..."
    const HEMOGRAMA = {
        codigo: '0202020380',
        itens: 'HB|HGB|HEMOGLOBINA|HT|HTC|HCT|HEMATOCRITO|HEMACIAS|ERITROCITOS|VCM|HCM|CHCM|RDW|LEUCO|LEUCOS|LEUC|LEUCOCITOS|'
            + 'NEUTROFILOS|NEUT|SEGMENTADOS|BASTOES|LINFOCITOS|LINF|MONOCITOS|MONO|EOSINOFILOS|EOS|BASOFILOS|BASO|PLAQ|PLAQUETAS|PLT',
    };

    // Exames de imagem: MODALIDADE + REGIÃO → código. "TC DE OMBRO" = TC + OMBRO.
    // Palavras de lateralidade/contraste e "DE/DA/DO" são ignoradas na região.
    const IMAGEM = {
        TC: {
            nome: 'TOMOGRAFIA COMPUTADORIZADA',
            apelidos: 'TC|TOMO|TOMOGRAFIA|TOMOGRAFIA COMPUTADORIZADA',
            regioes: [
                ['0206010010', 'DE COLUNA CERVICAL', 'COLUNA CERVICAL|CERVICAL'],
                ['0206010028', 'DE COLUNA LOMBO-SACRA', 'COLUNA LOMBOSSACRA|COLUNA LOMBO SACRA|COLUNA LOMBAR|LOMBOSSACRA|LOMBO SACRA|LOMBAR'],
                ['0206010036', 'DE COLUNA TORÁCICA', 'COLUNA TORACICA|COLUNA DORSAL|DORSAL'],
                ['0206010044', 'DE FACE / SEIOS DA FACE / ATM', 'SEIOS FACE|FACE|SEIOS PARANASAIS|ATM'],
                ['0206010052', 'DO PESCOÇO', 'PESCOCO'],
                ['0206010060', 'DE SELA TÚRCICA', 'SELA TURCICA|SELA|HIPOFISE'],
                ['0206010079', 'DO CRÂNIO', 'CRANIO|CRANIO ENCEFALO|ENCEFALO|CABECA'],
                ['0206020015', 'DE ARTICULAÇÕES DE MEMBRO SUPERIOR', 'OMBRO|OMBROS|COTOVELO|PUNHO|MAO|MEMBRO SUPERIOR|ARTICULACOES MEMBRO SUPERIOR'],
                ['0206020023', 'DE SEGMENTOS APENDICULARES', 'BRACO|ANTEBRACO|COXA|PERNA|PE|SEGMENTOS APENDICULARES'],
                ['0206020031', 'DE TÓRAX', 'TORAX|PULMAO|PULMOES|TCAR'],
                ['0206030010', 'DE ABDOME SUPERIOR', 'ABDOME SUPERIOR|ABDOMEN SUPERIOR|ABDOME|ABDOMEN|ABDOME TOTAL'],
                ['0206030037', 'DE PELVE / BACIA / ABDOME INFERIOR', 'PELVE|BACIA|ABDOME INFERIOR|ABDOMEN INFERIOR'],
                ['0206030029', 'DE ARTICULAÇÕES DE MEMBRO INFERIOR', 'QUADRIL|JOELHO|JOELHOS|TORNOZELO|MEMBRO INFERIOR|ARTICULACOES MEMBRO INFERIOR'],
            ],
        },
        RM: {
            nome: 'RESSONÂNCIA MAGNÉTICA',
            apelidos: 'RM|RNM|RMN|RESSONANCIA|RESSONANCIA MAGNETICA',
            regioes: [
                ['0207010021', 'DE ATM', 'ATM|ARTICULACAO TEMPORO MANDIBULAR'],
                ['0207010030', 'DE COLUNA CERVICAL/PESCOÇO', 'COLUNA CERVICAL|CERVICAL|PESCOCO'],
                ['0207010048', 'DE COLUNA LOMBO-SACRA', 'COLUNA LOMBOSSACRA|COLUNA LOMBO SACRA|COLUNA LOMBAR|LOMBOSSACRA|LOMBO SACRA|LOMBAR'],
                ['0207010056', 'DE COLUNA TORÁCICA', 'COLUNA TORACICA|COLUNA DORSAL|DORSAL'],
                ['0207010064', 'DE CRÂNIO', 'CRANIO|ENCEFALO|CRANIO ENCEFALO|CABECA'],
                ['0207010072', 'DE SELA TÚRCICA', 'SELA TURCICA|SELA|HIPOFISE'],
                ['0207020019', 'DE CORAÇÃO / AORTA', 'CORACAO|AORTA|CARDIACA'],
                ['0207020027', 'DE MEMBRO SUPERIOR', 'OMBRO|COTOVELO|PUNHO|MAO|BRACO|ANTEBRACO|MEMBRO SUPERIOR'],
                ['0207020035', 'DE TÓRAX', 'TORAX'],
                ['0207020060', 'DA MAMA', 'MAMA|MAMAS'],
                ['0207030014', 'DE ABDOME SUPERIOR', 'ABDOME SUPERIOR|ABDOMEN SUPERIOR|ABDOME|ABDOMEN'],
                ['0207030022', 'DE PELVE / BACIA', 'PELVE|BACIA|ABDOME INFERIOR'],
                ['0207030030', 'DE MEMBRO INFERIOR', 'QUADRIL|COXA|JOELHO|PERNA|TORNOZELO|PE|MEMBRO INFERIOR'],
                ['0207030049', 'DE VIAS BILIARES', 'VIAS BILIARES|COLANGIO|COLANGIORRESSONANCIA'],
                ['0207030057', 'MULTIPARAMÉTRICA DA PRÓSTATA', 'PROSTATA'],
            ],
        },
        USG: {
            nome: 'ULTRASSONOGRAFIA',
            apelidos: 'USG|US|ULTRASSOM|ULTRA SOM|ULTRASSONOGRAFIA|ULTRASONOGRAFIA|ECOGRAFIA',
            regioes: [
                ['0205020038', 'DE ABDOME SUPERIOR', 'ABDOME SUPERIOR|ABDOMEN SUPERIOR'],
                ['0205020046', 'DE ABDOME TOTAL', 'ABDOME TOTAL|ABDOMEN TOTAL|ABDOME|ABDOMEN|ABD TOTAL'],
                ['0205020054', 'DE APARELHO URINÁRIO', 'APARELHO URINARIO|VIAS URINARIAS|RINS VIAS URINARIAS|RINS|RENAL|URINARIO'],
                ['0205020062', 'DE ARTICULAÇÃO', 'ARTICULACAO|OMBRO|OMBROS|JOELHO|COTOVELO|PUNHO|QUADRIL|TORNOZELO'],
                ['0205020070', 'DE BOLSA ESCROTAL', 'BOLSA ESCROTAL|ESCROTO|TESTICULOS|TESTICULAR'],
                ['0205020097', 'MAMÁRIA BILATERAL', 'MAMA|MAMAS|MAMARIA|MAMARIA BILATERAL'],
                ['0205020100', 'DE PRÓSTATA (VIA ABDOMINAL)', 'PROSTATA|PROSTATA VIA ABDOMINAL'],
                ['0205020119', 'DE PRÓSTATA (TRANSRETAL)', 'PROSTATA TRANSRETAL|TRANSRETAL'],
                ['0205020127', 'DE TIREOIDE', 'TIREOIDE|TIROIDE'],
                ['0205020135', 'DE TÓRAX', 'TORAX'],
                ['0205020143', 'OBSTÉTRICA', 'OBSTETRICA|OBSTETRICO|OBST|GESTACIONAL|MORFOLOGICA'],
                ['0205020151', 'OBSTÉTRICA COM DOPPLER', 'OBSTETRICA COM DOPPLER|OBSTETRICA DOPPLER|DOPPLER OBSTETRICO'],
                ['0205020160', 'PÉLVICA (GINECOLÓGICA)', 'PELVICA|PELVE|GINECOLOGICA'],
                ['0205020186', 'TRANSVAGINAL', 'TRANSVAGINAL|TV|ENDOVAGINAL'],
                ['0205020178', 'TRANSFONTANELA', 'TRANSFONTANELA'],
                ['0205020089', 'DE GLOBO OCULAR / ÓRBITA', 'OCULAR|ORBITA|GLOBO OCULAR'],
                ['0205010040', 'DOPPLER COLORIDO DE VASOS', 'DOPPLER|DOPPLER VASOS|DOPPLER VENOSO|DOPPLER ARTERIAL|CAROTIDAS|DOPPLER CAROTIDAS'],
            ],
        },
        RX: {
            nome: 'RADIOGRAFIA',
            apelidos: 'RX|RAIO X|RAIOX|RADIOGRAFIA',
            regioes: [
                ['0204030153', 'DE TÓRAX (PA E PERFIL)', 'TORAX|TORAX PA PERFIL|TORAX PA LATERAL|TORAX PA'],
                ['0204020034', 'DE COLUNA CERVICAL', 'COLUNA CERVICAL|CERVICAL'],
                ['0204020069', 'DE COLUNA LOMBO-SACRA', 'COLUNA LOMBOSSACRA|COLUNA LOMBO SACRA|COLUNA LOMBAR|LOMBOSSACRA|LOMBO SACRA|LOMBAR'],
                ['0204020093', 'DE COLUNA TORÁCICA', 'COLUNA TORACICA|COLUNA DORSAL|DORSAL'],
                ['0204020107', 'DE COLUNA TORACO-LOMBAR', 'COLUNA TORACO LOMBAR|TORACOLOMBAR|TORACO LOMBAR'],
                ['0204020131', 'PANORÂMICA DE COLUNA TOTAL', 'COLUNA TOTAL|PANORAMICA COLUNA|ESCANOMETRIA'],
                ['0204010144', 'DE SEIOS DA FACE', 'SEIOS FACE|SEIOS PARANASAIS|SEIOS'],
                ['0204010080', 'DE CRÂNIO', 'CRANIO'],
                ['0204010063', 'DE CAVUM', 'CAVUM'],
                ['0204040116', 'DE ESCÁPULA/OMBRO', 'OMBRO|OMBROS|ESCAPULA'],
                ['0204040078', 'DE COTOVELO', 'COTOVELO'],
                ['0204040124', 'DE PUNHO', 'PUNHO'],
                ['0204040094', 'DE MÃO', 'MAO|MAOS'],
                ['0204060095', 'DE BACIA', 'BACIA|PELVE'],
                ['0204060060', 'DE ARTICULAÇÃO COXO-FEMORAL', 'QUADRIL|COXOFEMORAL|COXO FEMORAL'],
                ['0204060079', 'DE ARTICULAÇÃO SACRO-ILÍACA', 'SACROILIACA|SACRO ILIACA'],
                ['0204060125', 'DE JOELHO', 'JOELHO|JOELHOS'],
                ['0204060168', 'DE PERNA', 'PERNA'],
                ['0204060087', 'DE ARTICULAÇÃO TÍBIO-TÁRSICA', 'TORNOZELO|TIBIOTARSICA|TIBIO TARSICA'],
                ['0204060150', 'DE PÉ / DEDOS DO PÉ', 'PE|PES|DEDOS PE'],
                ['0204050138', 'DE ABDOME SIMPLES', 'ABDOME|ABDOMEN|ABDOME SIMPLES'],
                ['0204050120', 'DE ABDOME AGUDO', 'ABDOME AGUDO'],
            ],
        },
    };

    // Cabeçalhos de grupo: "LAB (20/10/2026): HB 12,3 GLICOSE 99 ..."
    const CATEGORIAS_EXAMES = 'LAB|LABS|LABORATORIO|LABORATORIAIS|EXAMES|EXAMES LABORATORIAIS|BIOQUIMICA|HEMATOLOGIA|HORMONIOS|SOROLOGIAS|SOROLOGIA|BIOQ';

    // Palavras ignoradas ao comparar a região do exame de imagem
    const IGNORAR_REGIAO = 'DE|DA|DO|DOS|DAS|E|EM|C|S|COM|SEM|CONTRASTE|DIREITO|DIREITA|ESQUERDO|ESQUERDA|DIR|ESQ|D|BILATERAL|BIL|AMBOS|AMBAS|UNILATERAL';

    /* =====================================================================
     * EXAMES: interpretação do texto
     * ===================================================================== */
    const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const compactar = (s) => normalizar(s).replace(/[^A-Z0-9]/g, '');
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "USG TV" → USG[\s-]*TV (espaço/hífen opcionais)
    const apelidoRe = (a) => a.trim().split(/[\s-]+/).map(escRe).join('[\\s\\-]*');

    let dicionario = null;
    function montarDicionario() {
        if (dicionario) return dicionario;
        const lista = []; // { re-fonte, def }
        for (const [cod, nome, apelidos] of EXAMES) {
            for (const a of apelidos.split('|')) lista.push({ a, def: { cod, nome } });
        }
        for (const a of HEMOGRAMA.itens.split('|')) {
            lista.push({ a, def: { cod: HEMOGRAMA.codigo, nome: 'HEMOGRAMA COMPLETO', item: a } });
        }
        lista.sort((x, y) => compactar(y.a).length - compactar(x.a).length);
        const porApelido = new Map(lista.map((x) => [compactar(x.a), x.def]));
        // Um grupo por apelido; o índice do grupo que casou identifica o exame
        // Bordas excluem "/" para não confundir unidade com exame (MG/DL ≠ magnésio)
        const re = new RegExp('(?<![A-Z0-9/])(?:' + lista.map((x) => '(' + apelidoRe(x.a) + ')').join('|') + ')(?![A-Z0-9/])', 'g');
        const modalidades = Object.values(IMAGEM).flatMap((m) => m.apelidos.split('|').map((a) => ({ a, m })))
            .sort((x, y) => y.a.length - x.a.length);
        const ignorar = new Set(IGNORAR_REGIAO.split('|'));
        const categorias = new Set(CATEGORIAS_EXAMES.split('|').map(compactar));
        dicionario = { lista, porApelido, re, modalidades, ignorar, categorias };
        return dicionario;
    }

    // "20/10/2026", "20/10/26", "20.10.2026", "10/2026" → { iso, br }
    function lerData(s) {
        let m = s.match(/(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})(?!\d)/);
        let d, mes, a;
        if (m) [, d, mes, a] = m;
        else if ((m = s.match(/(?<!\d)(\d{1,2})[\/.\-](\d{4})(?!\d)/))) [d, mes, a] = ['1', m[1], m[2]];
        else return null;
        if (a.length === 2) a = '20' + a;
        d = d.padStart(2, '0'); mes = mes.padStart(2, '0');
        if (+mes < 1 || +mes > 12 || +d < 1 || +d > 31) return null;
        return { iso: `${a}-${mes}-${d}`, br: `${d}/${mes}/${a}`, texto: m[0] };
    }

    // Cabeçalho é um exame de imagem? "TC DE COLUNA LOMBOSSACRA" → { cod, nome }
    function exameImagem(cab) {
        const dic = montarDicionario();
        const n = normalizar(cab).trim();
        for (const { a, m } of dic.modalidades) {
            const mm = n.match(new RegExp('^' + apelidoRe(a) + '(?![A-Z0-9])|^' + apelidoRe(a) + '(?=[A-Z])'));
            if (!mm) continue;
            const resto = n.slice(mm[0].length).split(/[^A-Z0-9]+/).filter((p) => p && !dic.ignorar.has(p)).join('');
            if (!resto) return { naoId: `${a}: região não informada` };
            let melhor = null;
            for (const [cod, nomeReg, apelidos] of m.regioes) {
                for (const ap of apelidos.split('|')) {
                    const c = ap.split(/\s+/).filter((p) => !dic.ignorar.has(p)).join('');
                    const nota = resto === c ? 1000 + c.length : resto.startsWith(c) ? 500 + c.length : resto.includes(c) ? c.length : 0;
                    if (nota > (melhor?.nota || 0)) melhor = { nota, cod, nome: `${m.nome} ${nomeReg}` };
                }
            }
            return melhor ? { cod: melhor.cod, nome: melhor.nome } : { naoId: `${a}: região "${n.slice(mm[0].length).trim()}" sem correspondência` };
        }
        return null;
    }

    // Valor de um exame laboratorial: número (+ unidade) e o que sobrar
    function separarValor(v) {
        const m = v.match(/^([<>≤≥]=?\s*)?\d+(?:[.,]\d+)*(?:\s*(?:%|[A-Za-zµ]+\/[A-Za-z0-9³]+|mil|x\s?10\S*))?/);
        if (!m) return { valor: v, sobra: '' }; // qualitativo ("NÃO REAGENTE", "NORMAL"...)
        const sobra = v.slice(m[0].length).trim();
        // sobra sem números é complemento ("(NORMAL)"); com número é outro exame não reconhecido
        return /\d/.test(sobra) ? { valor: m[0].trim(), sobra } : { valor: v, sobra: '' };
    }

    // "HB 12,3 GLICOSE 99 HBA1C 6,5%" → pares; texto sem apelido conhecido vai para naoId
    function lerPares(corpo, data, linha) {
        const dic = montarDicionario();
        const n = normalizar(corpo);
        const achados = [];
        dic.re.lastIndex = 0;
        for (let m; (m = dic.re.exec(n));) {
            const i = m.findIndex((g, k) => k > 0 && g !== undefined);
            achados.push({ ini: m.index, fim: m.index + m[0].length, def: dic.lista[i - 1].def, rotulo: m[0] });
        }
        const linhas = [], naoId = [];
        const limpar = (s) => s.replace(/^[\s:=,;|\-–]+|[\s,;|\-–]+$/g, '');
        const antes = limpar(corpo.slice(0, achados[0]?.ini ?? corpo.length));
        if (antes) naoId.push({ linha, texto: antes });
        achados.forEach((a, k) => {
            const bruto = limpar(corpo.slice(a.fim, achados[k + 1]?.ini ?? corpo.length));
            const { valor, sobra } = separarValor(bruto);
            if (sobra) naoId.push({ linha, texto: sobra });
            linhas.push({ linha, data, cod: a.def.cod, nome: a.def.nome, item: a.def.item && a.rotulo, resultado: valor });
        });
        return { linhas, naoId };
    }

    // Só linhas COM DATA são exames: o exame físico não tem data, e o sistema não salva exame sem data.
    //   "LAB (29/10/2026): ..." e "TC DE TORAX (29/10/2026): laudo" → exames
    //   "AO EXAME, BOM ESTADO GERAL..." / "ABD: FLÁCIDO..."             → ignoradas
    function interpretarExames(textoLivre) {
        const dic = montarDicionario();
        const linhas = [], naoId = [];
        textoLivre.split(/\r?\n/).forEach((bruta, i) => {
            const linha = i + 1;
            const t = bruta.trim().replace(/^[-•*]\s*/, ''); // marcadores de lista
            if (!t) return;
            const dp = t.indexOf(':');
            if (dp < 0) {
                // Sem "cabeçalho:": "GLICOSE 99 TSH 2 (20/10/2026)" — precisa de data e começar por um exame
                const data = lerData(t);
                if (!data) return;
                const r = lerPares(t.replace(data.texto, '').replace(/[()[\]]/g, ' '), data, linha);
                if (r.linhas.length && !r.naoId.some((x) => t.startsWith(x.texto))) { linhas.push(...r.linhas); naoId.push(...r.naoId); }
                return;
            }
            let cab = t.slice(0, dp);
            const corpo = t.slice(dp + 1).trim();
            const data = lerData(cab);
            if (!data) return;
            cab = cab.replace(data.texto, '').replace(/[()[\]\-–,]+/g, ' ').replace(/\s+/g, ' ').trim();
            const cabC = compactar(cab);

            if (!cabC || dic.categorias.has(cabC)) { // grupo de exames
                const r = lerPares(corpo, data, linha);
                linhas.push(...r.linhas); naoId.push(...r.naoId);
                return;
            }
            const lab = dic.porApelido.get(cabC);
            if (lab) { // "TSH (10/10/2026): 2,0"
                linhas.push({ linha, data, cod: lab.cod, nome: lab.nome, item: lab.item && cab, resultado: corpo });
                return;
            }
            const img = exameImagem(cab);
            if (img?.cod) { linhas.push({ linha, data, cod: img.cod, nome: img.nome, resultado: corpo }); return; }
            if (img?.naoId) { naoId.push({ linha, texto: `${cab} — ${img.naoId}` }); return; }
            // Cabeçalho desconhecido (com data): tenta ler o corpo como grupo
            const r = lerPares(corpo, data, linha);
            if (r.linhas.length) { linhas.push(...r.linhas); naoId.push(...r.naoId); }
            else naoId.push({ linha, texto: t }); // tem data: parece exame, mas não foi reconhecido
        });
        return { linhas: agruparItens(linhas), naoId };
    }

    // Junta os itens do hemograma (mesma data) numa linha só
    function agruparItens(linhas) {
        const saida = [], grupos = new Map();
        for (const l of linhas) {
            if (l.cod !== HEMOGRAMA.codigo) { saida.push(l); continue; }
            const chave = l.cod + '|' + (l.data?.iso || 'linha' + l.linha);
            const parte = l.item ? `${l.item} ${l.resultado}`.trim() : l.resultado;
            const g = grupos.get(chave);
            if (g) { if (parte) g.resultado = g.resultado ? `${g.resultado} · ${parte}` : parte; continue; }
            const novo = { ...l, item: undefined, resultado: parte };
            grupos.set(chave, novo);
            saida.push(novo);
        }
        return saida;
    }

    /* =====================================================================
     * EXAMES: lançamento no modal "Adicionar resultados de exames" do sistema
     * ===================================================================== */
    const dialogoExamesSistema = () => [...document.querySelectorAll('[role=dialog]')]
        .find((d) => texto(d.querySelector('h2')) === 'Adicionar resultados de exames');

    // Preenche o modal do sistema e o deixa aberto: quem clica em Salvar é você
    async function lancarExames(linhas) {
        await garantirSoap();
        let dlg = dialogoExamesSistema();
        if (!dlg) {
            await expandirSecao(SECOES.objetivo);
            const b = await esperar(() => botaoPorTexto(document.querySelector('main'), /^Adicionar resultados de exames$/), 4000);
            if (!b) throw new Error('botão "Adicionar resultados de exames" não encontrado');
            clicar(b);
            dlg = await esperar(dialogoExamesSistema, 4000);
            if (!dlg) throw new Error('modal de exames não abriu');
        }
        const falhas = [];
        for (const l of linhas) {
            const antes = new Set(dlg.querySelectorAll('[role=listitem]'));
            const combo = dlg.querySelector('[role=combobox]');
            if (!combo || !await selecionarNoCombobox(combo, l.cod)) { falhas.push(`${l.nome} (${l.cod}): não encontrado na lista do sistema`); continue; }
            const item = await esperar(() => [...dlg.querySelectorAll('[role=listitem]')].find((x) => !antes.has(x)), 3000);
            const ta = item?.querySelector('textarea');
            if (!ta) { falhas.push(`${l.nome}: linha não apareceu no modal`); continue; }
            if (l.resultado) definirValor(ta, l.resultado);
            else falhas.push(`${l.nome}: sem resultado`);
            if (!l.data) { falhas.push(`${l.nome}: sem data de realização`); continue; }
            // "Realizado em" só é liberado depois que o resultado é digitado
            const campo = await esperar(() => {
                const lbl = [...item.querySelectorAll('label')].find((x) => /^Realizado em/.test(texto(x)));
                const inp = lbl && document.getElementById(lbl.htmlFor);
                return inp && !inp.disabled ? inp : null;
            }, 2000);
            if (campo) definirValor(campo, l.data.iso);
            else falhas.push(`${l.nome}: não consegui preencher a data`);
            await sleep(150);
        }
        if (falhas.length) {
            const msg = `Exames lançados com pendências (${linhas.length - falhas.length}/${linhas.length}):\n• ` + falhas.join('\n• ');
            avisar(msg, 'aviso');
            atualizarStatus(msg);
        } else {
            avisar(`${linhas.length} exame(s) lançado(s). Confira e clique em Salvar.`, 'ok');
        }
        LOG('Exames lançados', linhas, 'falhas:', falhas);
    }

    /* =====================================================================
     * EXAMES: modal de digitação e prévia
     * ===================================================================== */
    let examesLidos = { linhas: [], naoId: [] };

    function modalExames() {
        let ov = document.getElementById('susauto-exames-modal');
        if (ov) return ov;
        ov = document.createElement('div');
        ov.id = 'susauto-exames-modal';
        ov.innerHTML = `
            <div class="card" role="dialog" aria-label="Lançar exames">
                <div class="topo"><b>Lançar resultados de exames</b><button type="button" class="x" title="Fechar">×</button></div>
                <p class="ajuda">Um grupo por linha: <code>LAB (20/10/2026): HB 12,3 GLICOSE 99 HBA1C 6,5%</code> ou
                    <code>TC DE OMBRO (15/09/2026): laudo…</code>. Linhas sem data (exame físico) são ignoradas. O texto do Objetivo é importado ao abrir.</p>
                <textarea spellcheck="false"></textarea>
                <div class="naoid"></div>
                <div class="tabela"></div>
                <div class="rodape"><span class="info"></span>
                    <div class="acoes"><button type="button" class="importar" title="Substitui o texto acima pelo do campo Objetivo">Importar do Objetivo</button>
                    <button type="button" class="inserir">Lançar no prontuário</button></div></div>
            </div>`;
        const ta = ov.querySelector('textarea');
        const fechar = () => ov.classList.remove('show');
        ta.addEventListener('input', () => previaExames(ov));
        ov.querySelector('.x').addEventListener('click', fechar);
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) fechar(); });
        ov.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') fechar();
            if (e.key === 'Enter' && e.ctrlKey) { // Ctrl+Enter = Lançar no prontuário
                e.preventDefault();
                const bt = ov.querySelector('.inserir');
                if (!bt.disabled) bt.click();
            }
        });
        ov.querySelector('.inserir').title = 'Ctrl+Enter';
        ov.querySelector('.importar').addEventListener('click', () => { ta.value = textoObjetivo(); previaExames(ov); });
        ov.querySelector('.tabela').addEventListener('change', (e) => {
            const i = e.target.dataset?.i;
            if (i === undefined) return;
            examesLidos.linhas[i].ignorar = !e.target.checked;
            e.target.closest('tr').classList.toggle('ignorar', !e.target.checked);
            infoExames(ov);
        });
        ov.querySelector('.inserir').addEventListener('click', () => {
            const escolhidos = examesLidos.linhas.filter((l) => !l.ignorar);
            if (!escolhidos.length) return;
            fechar();
            trabalhar('lançar exames', () => lancarExames(escolhidos));
        });
        document.body.appendChild(ov);
        return ov;
    }

    function textoObjetivo() {
        const ta = [...document.querySelectorAll('textarea')].find((t) => t.placeholder.startsWith(CAMPOS.objetivo));
        return ta?.value || '';
    }

    function previaExames(ov) {
        examesLidos = interpretarExames(ov.querySelector('textarea').value);
        const { linhas, naoId } = examesLidos;

        const caixa = ov.querySelector('.naoid');
        caixa.classList.toggle('show', naoId.length > 0);
        caixa.innerHTML = '<b></b><ul></ul>';
        caixa.querySelector('b').textContent = `⚠ ${naoId.length} trecho(s) não identificado(s) — não serão lançados:`;
        for (const n of naoId) {
            const li = document.createElement('li');
            li.textContent = `Linha ${n.linha}: ${n.texto}`;
            caixa.querySelector('ul').appendChild(li);
        }

        const tab = ov.querySelector('.tabela');
        if (!linhas.length) {
            tab.innerHTML = '<div class="vazio">Nenhum exame reconhecido.</div>';
        } else {
            tab.innerHTML = '<table><thead><tr><th></th><th>Data de realização</th><th>Exame</th><th>Resultado</th></tr></thead><tbody></tbody></table>';
            const tb = tab.querySelector('tbody');
            linhas.forEach((l, i) => {
                const tr = document.createElement('tr');
                if (!l.data) tr.classList.add('falta');
                tr.innerHTML = '<td><input type="checkbox" checked></td><td class="data"></td><td><span class="nome"></span><span class="cod"></span></td><td class="res"></td>';
                tr.querySelector('input').dataset.i = i;
                tr.querySelector('.data').textContent = l.data?.br || 'sem data';
                tr.querySelector('.nome').textContent = l.nome;
                tr.querySelector('.cod').textContent = l.cod;
                tr.querySelector('.res').textContent = l.resultado || '—';
                tb.appendChild(tr);
            });
        }
        infoExames(ov);
    }

    function infoExames(ov) {
        const n = examesLidos.linhas.filter((l) => !l.ignorar).length;
        const semData = examesLidos.linhas.filter((l) => !l.ignorar && !l.data).length;
        ov.querySelector('.info').textContent = `${n} exame(s) para lançar`
            + (semData ? ` · ${semData} sem data` : '') + (examesLidos.naoId.length ? ` · ${examesLidos.naoId.length} não identificado(s)` : '');
        const bt = ov.querySelector('.inserir');
        bt.disabled = !n;
        bt.textContent = n ? `Lançar ${n} no prontuário` : 'Lançar no prontuário';
    }

    async function abrirModalExames() {
        const ov = modalExames();
        const ta = ov.querySelector('textarea');
        const id = location.pathname.match(reAtendimento)?.[1] || '';
        if (ov.dataset.atendimento !== id) { ta.value = ''; ov.dataset.atendimento = id; } // outro paciente
        if (!ta.value.trim()) {
            await expandirSecao(SECOES.objetivo);
            ta.value = textoObjetivo();
        }
        ov.classList.add('show');
        previaExames(ov);
        ta.focus();
    }

    /* =====================================================================
     * RECEBIMENTO DOS COMANDOS DO AHK (Ctrl+V interceptado)
     * ===================================================================== */
    let fila = Promise.resolve();

    function receber(json) {
        let dados;
        try { dados = JSON.parse(json); } catch (e) {
            avisar('Comando do AHK inválido (JSON).', 'erro');
            return;
        }
        fila = fila.then(() => trabalhar('preenchimento', () => aplicar(dados)));
    }

    window.addEventListener('paste', (ev) => {
        const t = ev.clipboardData?.getData('text/plain') || '';
        if (!t.startsWith(CFG.prefixo)) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        receber(t.slice(CFG.prefixo.length));
    }, true);

    // Para testes pelo console: SUSAUTO.aplicar({...})
    window.SUSAUTO = { aplicar: (d) => receber(JSON.stringify(d)), CFG, UI, lerDocumentos, mostrarErros, interpretarExames,
        // texto livre ou lista [{ cod, nome, resultado, data: { iso } }]
        lancarExames: (x) => trabalhar('lançar exames', () => lancarExames(typeof x === 'string' ? interpretarExames(x).linhas : x)) };

    /* =====================================================================
     * OBSERVADOR DE NAVEGAÇÃO (Next.js troca de página sem recarregar)
     * ===================================================================== */
    const reAtendimento = /\/atendimento\/lista-atendimentos\/(\d+)/;
    let atendimentoAberto = null; // id do atendimento cuja aba SOAP já foi aberta automaticamente
    let soapEstavaAtivo = false;
    const padraoAplicado = new Set(); // atendimentos que já receberam SIGTAP/desfecho padrão

    let estavaNaLista = false;

    function tick() {
        montarBarra();

        // Uma vez por chegada à lista (depois disso o usuário pode desmarcar à vontade)
        const naLista = naListaAtendimentos();
        if (naLista && !estavaNaLista && CFG.filtrarMeusAoAbrirLista) trabalhar('filtrar meus atendimentos', filtrarMeusAtendimentos);
        estavaNaLista = naLista;

        const m = location.pathname.match(reAtendimento);
        const aba = abaSoap();
        if (!m || !aba) {
            if (!m) atendimentoAberto = null;
            soapEstavaAtivo = false;
            return;
        }

        if (CFG.abrirSoapAutomaticamente && atendimentoAberto !== m[1]) {
            atendimentoAberto = m[1];
            if (!soapAtivo()) trabalhar('abrir SOAP', () => garantirSoap());
        }

        const ativo = soapAtivo();
        if (ativo && !soapEstavaAtivo) {
            trabalhar('ao entrar no SOAP', async () => {
                if (CFG.recolherAntecedentes) await recolherAntecedentes();
                if (CFG.marcarTipoAtendimento) await marcarTipoAtendimento();
                const id = m[1];
                if (!padraoAplicado.has(id)) {
                    padraoAplicado.add(id);
                    const falhas = [];
                    try { falhas.push(...await adicionarIntervencoes('SIGTAP', CFG.sigtapPadrao)); } catch (e) { falhas.push(e.message); }
                    falhas.push(...await definirDesfecho(CFG.desfechoPadrao));
                    if (falhas.length) atualizarStatus('Padrão ao abrir com pendências:\n• ' + falhas.join('\n• '));
                }
                if (CFG.focarSubjetivo) await focarSubjetivo();
            });
        }
        soapEstavaAtivo = ativo;
    }

    setInterval(tick, 400);
    window.addEventListener('scroll', () => linhaPaciente(reAtendimento.test(location.pathname)), { passive: true });
    tick();
    LOG('carregado', 'v' + VERSAO);
})();
