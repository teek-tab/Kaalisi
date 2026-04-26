// ==================== THÈME ====================
(function initTheme() {
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        const savedTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
        toggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
        toggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next    = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('theme', next);
            toggle.textContent = next === 'dark' ? '🌙' : '☀️';
        });
    }
})();

// ==================== NAVIGATION ONGLETS ====================
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const tabEl  = document.getElementById('tab-' + tabName);
    const navBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
    if (tabEl)  tabEl.classList.add('active');
    if (navBtn) navBtn.classList.add('active');

    if (tabName === 'stats')    renderStatsTab();
    if (tabName === 'settings') renderSettingsTab();
    if (tabName === 'home')     renderRecentTransactions();
}

// ==================== RENDER ACCUEIL ====================
function renderAccountCards() {
    const container = document.getElementById('accountsCards');
    if (!container || !window.accountsMap) return;
    const emojis = { cash: '💵', wave: '📱', epargne: '💰' };
    container.innerHTML = Array.from(window.accountsMap.values()).map((a, i) => `
        <div class="account-card" style="animation-delay:${i * 0.07}s">
            <div class="account-card-icon">${emojis[a.name] || '🏦'}</div>
            <div class="account-card-name">${a.name}</div>
            <div class="account-card-balance">${Number(a.balance).toLocaleString('fr')} <span>F</span></div>
        </div>
    `).join('');
}

function renderHomeSummary() {
    if (!window.transactionsData) return;
    const txs = window.transactionsData;
    let expense = 0, income = 0;
    txs.forEach(t => {
        if (t.type === 'expense') expense += t.amount;
        else income += t.amount;
    });
    const net   = income - expense;
    const debut = window.currentPeriode?.debut;
    const fin   = window.currentPeriode?.fin;
    const nbJ   = debut && fin ? Math.max(1, Math.ceil((new Date(fin) - new Date(debut)) / 86400000)) : 30;
    const avg   = expense / nbJ;

    // FIX : setEl reçoit directement la valeur numérique, fmt est appelé à l'intérieur
    setEl('homeExpense', expense);
    setEl('homeIncome',  income);
    setEl('homeAvg',     avg);

    const netEl = document.getElementById('homeNet');
    if (netEl) {
        netEl.textContent  = (net >= 0 ? '+' : '') + fmt(net) + ' F';
        netEl.style.color  = net >= 0 ? 'var(--green)' : 'var(--red)';
    }
}

function renderRecentTransactions() {
    const container = document.getElementById('recentTransactions');
    if (!container || !window.transactionsData) return;
    const recent = [...window.transactionsData].slice(0, 4);
    if (!recent.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">💸</div>Aucune transaction</div>`;
        return;
    }
    container.innerHTML = recent.map(t => buildTxRow(t, true)).join('');
}

function buildTxRow(t, compact = false) {
    const cat  = t.categories || { name: 'Autres', icon: '📦' };
    const acc  = t.accounts   || { name: '?' };
    const sign = t.type === 'expense' ? '-' : '+';
    const cls  = t.type === 'expense' ? 'expense' : 'income';
    const desc = t.description || cat.name;
    const actions = compact ? '' : `
        <div class="tx-actions-inline">
            <button class="btn-icon-sm" onclick="editTransaction('${t.id}')">✏️</button>
            <button class="btn-icon-sm" onclick="deleteTransaction('${t.id}')">🗑️</button>
        </div>`;
    return `
        <div class="tx-row">
            <div class="tx-cat-badge">${cat.icon}</div>
            <div class="tx-info">
                <div class="tx-name">${desc}</div>
                <div class="tx-meta">${t.date} · ${acc.name}</div>
            </div>
            <div class="tx-amount ${cls}">${sign}${fmt(t.amount)}</div>
            ${actions}
        </div>`;
}

// ==================== ONGLET TRANSACTIONS ====================
function updateTransactionsTable() {
    const container    = document.getElementById('transactionsTableBody');
    const paginationDiv = document.getElementById('transactionsPagination');
    if (!container) return;

    let filtered = [...(window.transactionsData || [])];
    const ft = window.filterType || 'all';
    if (ft === 'expense') filtered = filtered.filter(t => t.type === 'expense');
    if (ft === 'income')  filtered = filtered.filter(t => t.type === 'income');

    const sc = window.sortColumn || 'date';
    const so = window.sortOrder  || 'desc';
    filtered.sort((a, b) => {
        let va, vb;
        if (sc === 'date')     { va = new Date(a.date); vb = new Date(b.date); }
        else if (sc === 'amount') { va = a.amount; vb = b.amount; }
        else { va = (a.categories?.name || '').toLowerCase(); vb = (b.categories?.name || '').toLowerCase(); }
        if (va < vb) return so === 'asc' ? -1 : 1;
        if (va > vb) return so === 'asc' ?  1 : -1;
        return 0;
    });

    const rpp        = window.rowsPerPage || 10;
    const totalPages = Math.ceil(filtered.length / rpp) || 1;
    if (window.currentPage > totalPages) window.currentPage = 1;
    const start = ((window.currentPage || 1) - 1) * rpp;
    const rows  = filtered.slice(start, start + rpp);

    if (!rows.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div>Aucune transaction trouvée</div>`;
    } else {
        container.innerHTML = rows.map(t => buildTxRow(t, false)).join('');
    }

    if (paginationDiv) {
        paginationDiv.innerHTML = `
            <span class="pagination-info">${filtered.length} transaction(s) · Page ${window.currentPage || 1}/${totalPages}</span>
            <div class="pagination-btns">
                <button class="page-btn" onclick="changePage(-1)" ${(window.currentPage||1) === 1 ? 'disabled' : ''}>◀</button>
                <button class="page-btn" onclick="changePage(1)"  ${(window.currentPage||1) >= totalPages ? 'disabled' : ''}>▶</button>
            </div>`;
    }
}

function setFilterType(type) {
    window.filterType  = type;
    window.currentPage = 1;
    document.querySelectorAll('.type-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.type === type);
    });
    updateTransactionsTable();
}

window.changePage = (delta) => {
    let count = window.transactionsData?.length || 0;
    if (window.filterType === 'expense') count = window.transactionsData?.filter(t => t.type === 'expense').length || 0;
    else if (window.filterType === 'income') count = window.transactionsData?.filter(t => t.type === 'income').length || 0;
    const total   = Math.ceil(count / (window.rowsPerPage || 10));
    const newPage = (window.currentPage || 1) + delta;
    if (newPage >= 1 && newPage <= total) { window.currentPage = newPage; updateTransactionsTable(); }
};

// ==================== ONGLET STATS ====================
const _comparisonCache = { key: '', data: null, time: 0 };
const _COMPARISON_CACHE_MS = 60000;

function renderStatsTab() {
    renderStatsKPIs();
    renderDonutChart();
    renderBalanceCurve();
    renderComparison();
    generateInsights();
}

function renderStatsKPIs() {
    const txs = window.transactionsData || [];
    let expense = 0, income = 0;
    txs.forEach(t => { if (t.type === 'expense') expense += t.amount; else income += t.amount; });
    const debut = window.currentPeriode?.debut;
    const fin   = window.currentPeriode?.fin;
    const nbJ   = debut && fin ? Math.max(1, Math.ceil((new Date(fin) - new Date(debut)) / 86400000)) : 30;

    const el = document.getElementById('statsKpis');
    if (!el) return;
    el.innerHTML = `
        <div class="kpi-card k-expense"><div class="kpi-label">💸 Dépenses</div><div class="kpi-value">${fmt(expense)} F</div></div>
        <div class="kpi-card k-income"><div class="kpi-label">💰 Revenus</div><div class="kpi-value">${fmt(income)} F</div></div>
        <div class="kpi-card k-avg"><div class="kpi-label">📊 Moy/jour</div><div class="kpi-value">${fmt(expense / nbJ)} F</div></div>
        <div class="kpi-card k-count"><div class="kpi-label">📅 Transactions</div><div class="kpi-value">${txs.length}</div></div>
    `;
}

function renderDonutChart() {
    const ctx = document.getElementById('expensesChart');
    if (!ctx) return;
    const totals = new Map();
    (window.transactionsData || []).forEach(t => {
        if (t.type === 'expense') {
            const n = t.categories?.name || 'Autres';
            totals.set(n, (totals.get(n) || 0) + t.amount);
        }
    });
    if (window.expensesChartInstance) window.expensesChartInstance.destroy();
    if (!totals.size) { ctx.parentElement.innerHTML += '<div class="empty-state">Aucune dépense</div>'; return; }
    window.expensesChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [...totals.keys()],
            datasets: [{
                data: [...totals.values()],
                backgroundColor: ['#00d68f','#ff5370','#4d9fff','#ffb547','#c084fc','#34d399'],
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            cutout: '65%',
            plugins: {
                legend: { position: 'bottom', labels: { color: '#9aa3b8', font: { size: 11 }, padding: 14, boxWidth: 10 } }
            }
        }
    });
}

function renderBalanceCurve() {
    const ctx = document.getElementById('balanceChart');
    if (!ctx) return;
    const txs = [...(window.transactionsData || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!txs.length) return;

    const byDate = new Map();
    txs.forEach(t => {
        const delta = t.type === 'income' ? t.amount : -t.amount;
        byDate.set(t.date, (byDate.get(t.date) || 0) + delta);
    });
    const dates  = [...byDate.keys()].sort();
    let running  = 0;
    const values = dates.map(d => { running += byDate.get(d); return running; });

    if (window.balanceChartInstance) window.balanceChartInstance.destroy();
    window.balanceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates.map(d => d.slice(5)),
            datasets: [{
                label: 'Solde net',
                data: values,
                borderColor: '#00d68f',
                backgroundColor: 'rgba(0,214,143,0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#00d68f',
                fill: true,
                tension: 0.35
            }]
        },
        options: {
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#5a6277', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#5a6277', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
            }
        }
    });
}

async function renderComparison() {
    const el = document.getElementById('compareCard');
    if (!el || !window.currentPeriode) return;

    const debut    = new Date(window.currentPeriode.debut);
    const fin      = new Date(window.currentPeriode.fin);
    const diff     = fin - debut;
    const prevDebut = new Date(debut - diff - 86400000).toISOString().slice(0, 10);
    const prevFin   = new Date(debut - 86400000).toISOString().slice(0, 10);
    const cacheKey  = `${prevDebut}_${prevFin}`;
    const now       = Date.now();

    if (_comparisonCache.key === cacheKey && now - _comparisonCache.time < _COMPARISON_CACHE_MS) {
        el.innerHTML = _comparisonCache.data;
        return;
    }

    try {
        const db = window.db;
        if (!db || !window.currentUser) { el.innerHTML = '<div class="empty-state">Données non disponibles</div>'; return; }

        const { data: prev } = await db.from('transactions')
            .select('amount,type')
            .eq('user_id', window.currentUser.id)
            .gte('date', prevDebut)
            .lte('date', prevFin);

        let prevExp = 0, prevInc = 0;
        (prev || []).forEach(t => { if (t.type === 'expense') prevExp += t.amount; else prevInc += t.amount; });
        let curExp = 0, curInc = 0;
        (window.transactionsData || []).forEach(t => { if (t.type === 'expense') curExp += t.amount; else curInc += t.amount; });

        const expDelta = prevExp ? Math.round((curExp - prevExp) / prevExp * 100) : null;
        const incDelta = prevInc ? Math.round((curInc - prevInc) / prevInc * 100) : null;
        const html = `
            <div class="compare-row">
                <span class="compare-label">💸 Dépenses</span>
                <span class="compare-val">${fmt(curExp)} F</span>
                ${deltaTag(expDelta, true)}
            </div>
            <div class="compare-row">
                <span class="compare-label">💰 Revenus</span>
                <span class="compare-val">${fmt(curInc)} F</span>
                ${deltaTag(incDelta, false)}
            </div>`;
        el.innerHTML = html;
        _comparisonCache.key  = cacheKey;
        _comparisonCache.data = html;
        _comparisonCache.time = now;
    } catch (e) {
        el.innerHTML = '<div class="empty-state">Impossible de charger la comparaison</div>';
    }
}

function deltaTag(pct, inverse) {
    if (pct === null) return `<span class="compare-delta delta-neutral">—</span>`;
    const isUp  = pct > 0;
    const isBad = inverse ? isUp : !isUp;
    const cls   = pct === 0 ? 'delta-neutral' : isBad ? 'delta-up' : 'delta-down';
    return `<span class="compare-delta ${cls}">${pct > 0 ? '+' : ''}${pct}%</span>`;
}

async function generateInsights() {
    const el = document.getElementById('insightsContent');
    if (!el) return;
    const txs = window.transactionsData || [];
    if (!txs.length) { el.innerHTML = '<p>Aucune donnée pour cette période.</p>'; return; }

    let expense = 0, income = 0;
    const catMap = new Map();
    txs.forEach(t => {
        if (t.type === 'expense') {
            expense += t.amount;
            const n = t.categories?.name || 'Autres';
            catMap.set(n, (catMap.get(n) || 0) + t.amount);
        } else income += t.amount;
    });
    const debut  = window.currentPeriode?.debut;
    const fin    = window.currentPeriode?.fin;
    const nbJ    = debut && fin ? Math.max(1, Math.ceil((new Date(fin) - new Date(debut)) / 86400000)) : 30;
    const avg    = expense / nbJ;
    const net    = income - expense;
    const topCat = [...catMap.entries()].sort((a, b) => b[1] - a[1])[0];
    el.innerHTML = `
        <p>📉 Moyenne/jour : <strong>${fmt(avg)} F</strong></p>
        <p>⚖️ Solde net : <strong style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'}">${net >= 0 ? '+' : ''}${fmt(net)} F</strong></p>
        ${topCat ? `<p>🏆 Catégorie principale : <strong>${topCat[0]}</strong> (${fmt(topCat[1])} F)</p>` : ''}
        <p>💡 ${avg > 5000 ? '⚠️ Dépenses élevées, pensez à optimiser.' : '✅ Bon contrôle de vos dépenses.'}</p>
    `;
}

// ==================== ONGLET PARAMÈTRES ====================
function renderSettingsTab() {
    renderAccountsSettings();
    renderCategoriesSettings();
    const emailEl = document.getElementById('settingsEmail');
    if (emailEl && window.currentUser) emailEl.textContent = window.currentUser.email;
}

function renderAccountsSettings() {
    const el = document.getElementById('accountsListSettings');
    if (!el || !window.accountsMap) return;
    const emojis = { cash: '💵', wave: '📱', epargne: '💰' };
    const items  = Array.from(window.accountsMap.values());
    if (!items.length) { el.innerHTML = '<div class="empty-state">Aucun compte</div>'; return; }
    el.innerHTML = items.map(a => `
        <div class="settings-item">
            <div class="settings-item-left">
                <div class="settings-item-icon">${emojis[a.name] || '🏦'}</div>
                <div>
                    <div class="settings-item-name">${a.name}</div>
                    <div class="settings-item-sub">${Number(a.balance).toLocaleString('fr')} F</div>
                </div>
            </div>
            <div class="settings-item-actions">
                <button class="settings-btn" onclick="editAccountSettings('${a.id}')">✏️</button>
                <button class="settings-btn danger" onclick="deleteAccountSettings('${a.id}')">🗑️</button>
            </div>
        </div>`).join('');
}

function renderCategoriesSettings() {
    const el    = document.getElementById('categoriesListSettings');
    if (!el || !window.categoriesMap) return;
    const items = Array.from(window.categoriesMap.values());
    if (!items.length) { el.innerHTML = '<div class="empty-state">Aucune catégorie</div>'; return; }
    el.innerHTML = items.map(c => `
        <div class="settings-item">
            <div class="settings-item-left">
                <div class="settings-item-icon">${c.icon || '📂'}</div>
                <div class="settings-item-name">${c.name}</div>
            </div>
            <div class="settings-item-actions">
                <button class="settings-btn danger" onclick="deleteCategorySettings('${c.id}')">🗑️</button>
            </div>
        </div>`).join('');
}

window.editAccountSettings = async (id) => {
    const acc = window.accountsMap?.get(id);
    if (!acc) return;
    const newName = prompt('Nouveau nom :', acc.name);
    if (newName && newName !== acc.name) {
        await window.db.from('accounts').update({ name: newName }).eq('id', id);
        acc.name = newName;
        renderAccountCards();
        renderSettingsTab();
    }
};

window.deleteAccountSettings = async (id) => {
    const acc = window.accountsMap?.get(id);
    if (!acc || !confirm(`Supprimer "${acc.name}" ?`)) return;
    await window.db.from('accounts').delete().eq('id', id).eq('user_id', window.currentUser.id);
    window.accountsMap.delete(id);
    renderAccountCards();
    renderSettingsTab();
};

window.deleteCategorySettings = async (id) => {
    const cat = window.categoriesMap?.get(id);
    if (!cat || !confirm(`Supprimer "${cat.name}" ?`)) return;
    await window.db.from('categories').delete().eq('id', id).eq('user_id', window.currentUser.id);
    window.categoriesMap.delete(id);
    renderCategoriesSettings();
};

// ==================== HELPERS ====================
function fmt(n) {
    return Math.round(n).toLocaleString('fr');
}

// FIX : setEl reçoit une valeur numérique et formate avec fmt() à l'intérieur
// Cohérent avec l'appel dans renderHomeSummary (setEl('homeExpense', expense))
function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = fmt(val) + ' F';
}

function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('open');
}

window.closeModal = function(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
};

function setTransType(value) {
    const hiddenInput = document.getElementById('transType');
    if (hiddenInput) hiddenInput.value = value;
    document.querySelectorAll('.type-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === value);
    });
}

function loadPeriodStats(period) {
    document.querySelectorAll('#tab-stats .pill').forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
    });
    if (window.loadPeriod) window.loadPeriod(period).then(() => renderStatsTab());
}

function exportCSV() {
    const txs = window.transactionsData || [];
    if (!txs.length) { alert('Aucune transaction à exporter.'); return; }
    const header = ['Date', 'Type', 'Montant (F)', 'Catégorie', 'Compte', 'Description'];
    const rows   = txs.map(t => [
        t.date,
        t.type === 'expense' ? 'Dépense' : 'Revenu',
        t.amount,
        t.categories?.name || 'Autres',
        t.accounts?.name || '?',
        (t.description || '').replace(/,/g, ';')
    ]);
    const csv  = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = `xaalis_export_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

// ==================== PATCH APP.JS ====================

// FIX : updateBalancesDisplay — nav.js étend la version d'app.js
// au lieu de la remplacer complètement
const _origUpdateBalances = window.updateBalancesDisplay;
window.updateBalancesDisplay = function() {
    if (_origUpdateBalances) _origUpdateBalances();
    renderAccountCards();
    const badge = document.getElementById('userEmailShort');
    if (badge && window.currentUser) badge.textContent = window.currentUser.email.split('@')[0];
};

// FIX : refreshDashboard — app.js expose sa propre version via window.refreshDashboard.
// nav.js la surcharge pour ajouter les renders UI, mais appelle l'original d'app.js
// en capturant la référence APRÈS le chargement d'app.js (ordre : app.js → nav.js).
// window._origRefresh était undefined car jamais assigné dans l'ancien app.js.
const _origRefreshDashboard = window.refreshDashboard;
let _navRefreshing = false;

window.refreshDashboard = async function() {
    if (_navRefreshing) return;
    _navRefreshing = true;
    try {
        if (_origRefreshDashboard) await _origRefreshDashboard();
        renderAccountCards();
        renderHomeSummary();
        renderRecentTransactions();
        updateTransactionsTable();
    } finally {
        _navRefreshing = false;
    }
};

window.updateTransactionsTable = updateTransactionsTable;

// ==================== MODAL TRANSACTION (surcharge nav.js) ====================
window.openTransactionModal = function(mode = 'add', id = null) {
    const title = document.getElementById('transactionModalTitle');
    if (title) title.textContent = mode === 'edit' ? 'Modifier transaction' : 'Ajouter transaction';

    const form   = document.getElementById('transactionForm');
    form.dataset.mode          = mode;
    form.dataset.transactionId = id || '';

    const catSel = document.getElementById('transCategory');
    const accSel = document.getElementById('transAccount');
    catSel.innerHTML = '<option value="">— Choisir —</option>' +
        Array.from((window.categoriesMap || new Map()).values())
            .map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
    accSel.innerHTML = '<option value="">— Choisir —</option>' +
        Array.from((window.accountsMap || new Map()).values())
            .map(a => `<option value="${a.id}">${a.name}</option>`).join('');

    if (mode === 'edit' && id) {
        const t = (window.transactionsData || []).find(x => x.id === id);
        if (t) {
            document.getElementById('transAmount').value      = t.amount;
            document.getElementById('transDescription').value = t.description || '';
            setTransType(t.type);
            document.getElementById('transDate').value        = t.date;
            catSel.value = t.category_id || '';
            accSel.value = t.account_id  || '';
        }
    } else {
        form.reset();
        document.getElementById('transDate').value = new Date().toISOString().slice(0, 10);
        setTransType('expense');
    }
    openModal('transactionModal');
};

// ==================== EVENTS ====================
document.getElementById('openAddAccountBtn')?.addEventListener('click', () => openModal('addAccountModal'));
document.getElementById('openAddCategoryBtn')?.addEventListener('click', () => openModal('addCategoryModal'));

document.getElementById('addAccountBtn')?.addEventListener('click', async () => {
    const name    = document.getElementById('newAccountName').value.trim().toLowerCase().replace(/\s+/g, '_');
    const balance = parseFloat(document.getElementById('newAccountBalance').value) || 0;
    if (!name || !window.currentUser || !window.db) return;
    const { data } = await window.db.from('accounts')
        .insert({ user_id: window.currentUser.id, name, balance })
        .select();
    if (data?.[0]) {
        window.accountsMap.set(data[0].id, data[0]);
        document.getElementById('newAccountName').value    = '';
        document.getElementById('newAccountBalance').value = '0';
        closeModal('addAccountModal');
        renderAccountCards();
        renderSettingsTab();
    }
});

document.getElementById('addCategoryBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newCategoryName').value.trim();
    const icon = document.getElementById('newCategoryIcon').value.trim() || '📌';
    if (!name || !window.currentUser || !window.db) return;
    const { data } = await window.db.from('categories')
        .insert({ user_id: window.currentUser.id, name, icon })
        .select();
    if (data?.[0]) {
        window.categoriesMap.set(data[0].id, data[0]);
        document.getElementById('newCategoryName').value = '';
        document.getElementById('newCategoryIcon').value = '';
        closeModal('addCategoryModal');
        renderCategoriesSettings();
    }
});

document.getElementById('logoutBtn')?.addEventListener('click', () => {
    if (window.logout) window.logout();
});
