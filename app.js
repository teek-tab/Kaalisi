// ==================== CONFIGURATION =====================
const SUPABASE_URL = 'https://vsvvtyjbdrldlcswujzg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzdnZ0eWpiZHJsZGxjc3d1anpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDUyNTEsImV4cCI6MjA5MjcyMTI1MX0.YgkmLIoPJi3FQI6LvBVudB76LkMjR2Jywr8SZjNj1no';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.db = db;

let currentUser = null;
let currentPeriode = { debut: '', fin: '' };
let categoriesMap = new Map();
let accountsMap = new Map();
let transactionsData = [];
let lastCreatedTransactionId = null;

let currentPage = 1;
const rowsPerPage = 10;
let filterType = 'all';
let sortColumn = 'date';
let sortOrder = 'desc';

let conversationMessages = [];

// ========== CACHE & VERROUS ==========
let refreshPromise = null;
let lastUserDataLoad = 0;
const USER_DATA_CACHE_MS = 30000;
let lastTransactionsLoad = { key: '', time: 0 };
const TRANSACTIONS_CACHE_MS = 10000;

// DOM
const authScreen = document.getElementById('authScreen');
const dashboard = document.getElementById('dashboardScreen');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
let expensesChart = null;

// ==================== AUTH ====================
async function login() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) alert('Erreur: ' + error.message);
    else checkAuth();
}
async function register() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const { error } = await db.auth.signUp({ email, password });
    if (error) alert(error.message);
    else alert('Inscription réussie ! Vérifiez votre "email" pour vous connectez.');
}
async function logout() { await db.auth.signOut(); window.location.reload(); }

async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        window.currentUser = currentUser;
        authScreen.style.display = 'none';
        dashboard.style.display = 'block';
        const userEmailSpan = document.getElementById('userEmail');
        if (userEmailSpan) userEmailSpan.textContent = currentUser.email;
        await loadUserData(true);
        await loadPeriod('month');
        resetConversation();
        addChatMessage('system', '🟢 Connecté ! Parlez naturellement.');
    } else {
        authScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// ==================== CONVERSATION ====================
function addChatMessage(sender, text) {
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'user-msg' : (sender === 'ai' ? 'ai-msg' : 'system-msg');
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
function resetConversation() {
    conversationMessages = [];
    chatMessages.innerHTML = '';
    addChatMessage('system', '🔄 Nouvelle conversation. Prêt à vous aider.');
}
function getActionDescription(inst) {
    switch (inst.action) {
        case 'add_expense': return `Dépense ajoutée : ${inst.amount}F (${inst.category || 'Autres'}) sur ${inst.account}`;
        case 'add_income': return `Revenu ajouté : ${inst.amount}F (${inst.category || 'Autres'}) sur ${inst.account}`;
        case 'add_to_savings': return `${inst.amount}F transférés vers l'épargne depuis ${inst.source || 'cash'}`;
        case 'delete_transaction': return `Transaction supprimée`;
        case 'update_transaction': return `Transaction modifiée`;
        case 'fetch_balance': return `Solde total consulté`;
        case 'query': return `Analyse effectuée : ${inst.type || ''}`;
        default: return inst.message || '';
    }
}
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    addChatMessage('user', message);
    userInput.value = '';
    conversationMessages.push({ role: 'user', content: message });

    const tempDiv = document.createElement('div');
    tempDiv.className = 'ai-msg';
    tempDiv.textContent = '⏳ ...';
    chatMessages.appendChild(tempDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                periode: currentPeriode,
                history: [...conversationMessages],
                currentDate: new Date().toISOString().split('T')[0],
                currentDateTime: new Date().toISOString()
            })
        });

        const result = await res.json();
        tempDiv.remove();

        let aiText = '';

        if (result.action && result.action !== 'answer' && result.action !== 'clarify') {
            await executeInstruction(result);
            aiText = result.message || getActionDescription(result);
            await refreshDashboard();
        } else {
            aiText = result.message || '';
            addChatMessage('ai', aiText);
        }

        if (aiText) {
            conversationMessages.push({ role: 'assistant', content: aiText });
        }

    } catch (err) {
        tempDiv.remove();
        addChatMessage('ai', '❌ Erreur de connexion.');
        conversationMessages.pop();
        console.error(err);
    }
}
async function executeInstruction(inst) {
    try {
        switch (inst.action) {
            case 'add_expense':
            case 'add_income':
                await handleAddTransaction(inst);
                break;
            case 'add_to_savings':
                await handleAddToSavings(inst);
                break;
            case 'delete_transaction':
                await handleDeleteTransaction(inst);
                break;
            case 'update_transaction':
                await handleUpdateTransaction(inst);
                break;
            case 'add_account':
                await handleAddAccount(inst);
                break;
            case 'update_account':
                await handleUpdateAccount(inst);
                break;
            case 'fetch_balance': {
                let total = 0;
                for (let acc of accountsMap.values()) total += acc.balance;
                addChatMessage('ai', `💰 Solde total : ${total} F`);
                break;
            }
            case 'query':
                if (inst.type === 'total') {
                    const tot = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
                    addChatMessage('ai', `📊 Total dépenses : ${tot} F`);
                } else if (inst.type === 'forecast') {
                    const today = new Date();
                    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
                    const daysPassed = today.getDate();
                    const spent = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
                    const avg = spent / (daysPassed || 1);
                    const forecast = avg * (daysInMonth - daysPassed);
                    addChatMessage('ai', `📈 Prévision fin de mois : ~${Math.round(forecast)} F supplémentaires`);
                } else if (inst.type === 'best_days') {
                    const dayMap = new Map();
                    transactionsData.forEach(t => {
                        if (t.type === 'expense') {
                            const d = new Date(t.date).getDay();
                            dayMap.set(d, (dayMap.get(d) || 0) + t.amount);
                        }
                    });
                    let best = null, min = Infinity;
                    for (let [d, v] of dayMap) if (v < min) { min = v; best = d; }
                    const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
                    addChatMessage('ai', best !== null ? `🔥 Moins de dépenses le ${days[best]} (${min}F)` : "Pas assez de données");
                } else {
                    addChatMessage('ai', inst.message || 'Analyse effectuée.');
                }
                break;
            case 'clarify':
                addChatMessage('ai', inst.message || 'Pouvez-vous préciser ?');
                break;
            case 'answer':
                addChatMessage('ai', inst.message || '');
                break;
            default:
                addChatMessage('ai', inst.message || "Je n'ai pas compris.");
        }
    } catch (e) {
        console.error(e);
        addChatMessage('ai', "❌ Erreur lors de l'exécution.");
    }
}
async function handleAddTransaction(inst) {
    let catId = null;
    for (let [id, cat] of categoriesMap) if (cat.name.toLowerCase() === (inst.category || '').toLowerCase()) { catId = id; break; }
    if (!catId && inst.category) {
        const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: inst.category, icon: '📌' }).select();
        if (data?.[0]) { catId = data[0].id; categoriesMap.set(catId, data[0]); }
    }
    let accId = null;
    for (let [id, acc] of accountsMap) if (acc.name === inst.account) { accId = id; break; }
    if (!accId) { addChatMessage('ai', `❌ Compte "${inst.account}" introuvable.`); return; }
    const isIncome = inst.action === 'add_income';
    const { data, error } = await db.from('transactions').insert({
        user_id: currentUser.id,
        amount: inst.amount,
        description: inst.description || '',
        category_id: catId,
        account_id: accId,
        type: isIncome ? 'income' : 'expense',
        date: inst.date || new Date().toISOString().slice(0, 10)
    }).select();
    if (!error && data?.[0]) {
        lastCreatedTransactionId = data[0].id;
        const acc = accountsMap.get(accId);
        const newBalance = isIncome ? acc.balance + inst.amount : acc.balance - inst.amount;
        await db.from('accounts').update({ balance: newBalance }).eq('id', accId);
        acc.balance = newBalance;
        updateBalancesDisplay();
        addChatMessage('ai', `${isIncome ? '💰 Revenu' : '💸 Dépense'} ajouté : ${inst.amount} F (${inst.category || 'Autres'}) sur ${inst.account}`);
    } else { addChatMessage('ai', '❌ Erreur ajout.'); }
}
async function handleAddToSavings(inst) {
    const src = inst.source || 'cash';
    let srcId = null, epId = null;
    for (let [id, a] of accountsMap) { if (a.name === src) srcId = id; if (a.name === 'epargne') epId = id; }
    if (!srcId || !epId) { addChatMessage('ai', '❌ Compte introuvable.'); return; }
    const srcAcc = accountsMap.get(srcId);
    const epAcc = accountsMap.get(epId);
    if (srcAcc.balance < inst.amount) { addChatMessage('ai', `❌ Solde ${src} insuffisant`); return; }
    await db.from('accounts').update({ balance: srcAcc.balance - inst.amount }).eq('id', srcId);
    await db.from('accounts').update({ balance: epAcc.balance + inst.amount }).eq('id', epId);
    srcAcc.balance -= inst.amount;
    epAcc.balance += inst.amount;
    updateBalancesDisplay();
    addChatMessage('ai', `💰 ${inst.amount}F transférés de ${src} vers épargne`);
}
async function handleDeleteTransaction(inst) {
    const transId = inst.transaction_id || lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai', '❌ Aucune transaction à supprimer.'); return; }
    const { data: t } = await db.from('transactions').select('*').eq('id', transId).eq('user_id', currentUser.id).single();
    if (!t) { addChatMessage('ai', '❌ Transaction introuvable.'); return; }
    const acc = accountsMap.get(t.account_id);
    if (acc) {
        const newBal = t.type === 'income' ? acc.balance - t.amount : acc.balance + t.amount;
        await db.from('accounts').update({ balance: newBal }).eq('id', t.account_id);
        acc.balance = newBal;
        updateBalancesDisplay();
    }
    await db.from('transactions').delete().eq('id', transId).eq('user_id', currentUser.id);
    addChatMessage('ai', `🗑️ Transaction supprimée (${t.amount}F)`);
}
async function handleUpdateTransaction(inst) {
    const transId = inst.transaction_id || lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai', '❌ Aucune transaction à modifier.'); return; }
    const { data: t } = await db.from('transactions').select('*').eq('id', transId).eq('user_id', currentUser.id).single();
    if (!t) { addChatMessage('ai', '❌ Transaction introuvable.'); return; }
    const oldAcc = accountsMap.get(t.account_id);
    if (oldAcc) {
        const oldBal = t.type === 'income' ? oldAcc.balance - t.amount : oldAcc.balance + t.amount;
        await db.from('accounts').update({ balance: oldBal }).eq('id', t.account_id);
        oldAcc.balance = oldBal;
    }
    const fields = inst.fields_to_update || {};
    const updates = {};
    if (fields.amount !== undefined) updates.amount = fields.amount;
    if (fields.description !== undefined) updates.description = fields.description;
    if (fields.date !== undefined) updates.date = fields.date;
    let newAccId = t.account_id;
    if (fields.account) {
        for (let [id, a] of accountsMap) if (a.name === fields.account) { newAccId = id; break; }
        updates.account_id = newAccId;
    }
    if (fields.category) {
        let catId = null;
        for (let [id, c] of categoriesMap) if (c.name.toLowerCase() === fields.category.toLowerCase()) { catId = id; break; }
        if (!catId) {
            const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: fields.category, icon: '📌' }).select();
            if (data?.[0]) { catId = data[0].id; categoriesMap.set(catId, data[0]); }
        }
        if (catId) updates.category_id = catId;
    }
    await db.from('transactions').update(updates).eq('id', transId);
    const newAcc = accountsMap.get(newAccId);
    const newAmount = updates.amount !== undefined ? updates.amount : t.amount;
    if (newAcc) {
        const delta = t.type === 'income' ? newAmount : -newAmount;
        await db.from('accounts').update({ balance: newAcc.balance + delta }).eq('id', newAccId);
        newAcc.balance += delta;
    }
    updateBalancesDisplay();
    addChatMessage('ai', '✏️ Transaction modifiée.');
}
async function handleAddAccount(inst) {
    const name = (inst.new_name || '').toLowerCase().replace(/\s+/g, '_');
    if (!name) return;
    const { data, error } = await db.from('accounts').insert({ user_id: currentUser.id, name, balance: inst.balance || 0 }).select();
    if (!error && data?.[0]) { accountsMap.set(data[0].id, data[0]); updateBalancesDisplay(); addChatMessage('ai', `🏦 Compte "${name}" créé.`); }
}
async function handleUpdateAccount(inst) {
    let accId = null;
    for (let [id, a] of accountsMap) if (a.name === inst.old_name) { accId = id; break; }
    if (!accId) return;
    const newName = (inst.new_name || '').toLowerCase().replace(/\s+/g, '_');
    const upd = { name: newName };
    if (inst.balance !== undefined) upd.balance = inst.balance;
    await db.from('accounts').update(upd).eq('id', accId);
    const acc = accountsMap.get(accId);
    acc.name = newName;
    if (inst.balance !== undefined) acc.balance = inst.balance;
    updateBalancesDisplay();
    addChatMessage('ai', `🏦 Compte renommé : "${inst.old_name}" → "${newName}".`);
}

// ==================== DONNÉES AVEC CACHE ====================
async function loadUserData(force = false) {
    const now = Date.now();
    if (!force && now - lastUserDataLoad < USER_DATA_CACHE_MS && accountsMap.size > 0 && categoriesMap.size > 0) {
        console.log('[CACHE] loadUserData skipped — données fraîches');
        return;
    }
    lastUserDataLoad = now;

    const { data: accounts } = await db.from('accounts').select('*').eq('user_id', currentUser.id);
    if (accounts) { accountsMap.clear(); accounts.forEach(a => accountsMap.set(a.id, a)); updateBalancesDisplay(); }
    const { data: cats } = await db.from('categories').select('*').eq('user_id', currentUser.id);
    if (cats) { categoriesMap.clear(); cats.forEach(c => categoriesMap.set(c.id, c)); }
    window.accountsMap = accountsMap;
    window.categoriesMap = categoriesMap;
}
function updateBalancesDisplay() {
    // Élément optionnel, peut ne pas exister
    const balancesDiv = document.getElementById('balances');
    if (balancesDiv) {
        balancesDiv.innerHTML = Array.from(accountsMap.values()).map(a => `<span>${getEmoji(a.name)} ${a.name}: ${a.balance} F</span>`).join('');
    }
}
function getEmoji(name) { return { cash: '💵', wave: '📱', epargne: '💰' }[name] || '🏦'; }

// ==================== PÉRIODE ====================
function getDateRange(period) {
    const now = new Date();
    if (period === 'week') {
        const s = new Date(now); s.setDate(now.getDate() - now.getDay());
        return { debut: s.toISOString().slice(0, 10), fin: now.toISOString().slice(0, 10) };
    } else if (period === 'month') {
        return {
            debut: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
            fin: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)
        };
    } else {
        return {
            debut: new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10),
            fin: new Date(now.getFullYear(), 11, 31).toISOString().slice(0, 10)
        };
    }
}
async function loadPeriod(period) {
    currentPeriode = getDateRange(period);
    window.currentPeriode = currentPeriode;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.filter-btn[data-period="${period}"]`)?.classList.add('active');
    lastTransactionsLoad = { key: '', time: 0 };
    await refreshDashboard();
}
async function setPeriodeCustom() {
    const debut = document.getElementById('dateDebut').value;
    const fin = document.getElementById('dateFin').value;
    if (debut && fin) { 
        currentPeriode = { debut, fin }; 
        window.currentPeriode = currentPeriode; 
        lastTransactionsLoad = { key: '', time: 0 };
        await refreshDashboard(); 
    }
}

// ==================== REFRESH AVEC VERROU GLOBAL ====================
async function refreshDashboard() {
    if (refreshPromise) {
        console.log('[REFRESH] Déjà en cours, attente...');
        return refreshPromise;
    }

    refreshPromise = (async () => {
        try {
            await loadTransactions();
            await loadUserData();
            updateStats();
            updateChart();
            updateTransactionsTable();
            await generateInsights();
        } catch (err) {
            console.error('[REFRESH] Erreur:', err);
        }
    })();

    try {
        await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

async function loadTransactions() {
    const cacheKey = `${currentUser.id}_${currentPeriode.debut}_${currentPeriode.fin}`;
    const now = Date.now();

    if (now - lastTransactionsLoad.time < TRANSACTIONS_CACHE_MS && lastTransactionsLoad.key === cacheKey) {
        console.log('[CACHE] loadTransactions skipped — même période, données fraîches');
        return;
    }

    const { data } = await db.from('transactions')
        .select('*, categories(name,icon), accounts(name)')
        .eq('user_id', currentUser.id)
        .gte('date', currentPeriode.debut)
        .lte('date', currentPeriode.fin)
        .order('date', { ascending: false });
    transactionsData = data || [];
    window.transactionsData = transactionsData;
    lastTransactionsLoad = { key: cacheKey, time: Date.now() };
}
function updateStats() {
    let total = 0, income = 0;
    transactionsData.forEach(t => { if (t.type === 'expense') total += t.amount; if (t.type === 'income') income += t.amount; });
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)));
    // Élément optionnel
    const statsContainer = document.getElementById('statsContainer');
    if (statsContainer) {
        statsContainer.innerHTML = `
            <div class="stat-card"><h3>💸 Dépenses</h3><div class="stat-number">${total.toFixed(0)} F</div></div>
            <div class="stat-card"><h3>📈 Revenus</h3><div class="stat-number">${income.toFixed(0)} F</div></div>
            <div class="stat-card"><h3>📊 Moy/jour</h3><div class="stat-number">${(total / nbJ).toFixed(0)} F</div></div>
            <div class="stat-card"><h3>📅 Transactions</h3><div class="stat-number">${transactionsData.length}</div></div>
        `;
    }
}
function updateChart() {
    const ctx = document.getElementById('expensesChart');
    if (!ctx) return;
    const totals = new Map();
    transactionsData.forEach(t => { if (t.type === 'expense') { const n = t.categories?.name || 'Autres'; totals.set(n, (totals.get(n) || 0) + t.amount); } });
    if (expensesChart) expensesChart.destroy();
    if (!totals.size) return;
    expensesChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: [...totals.keys()], datasets: [{ data: [...totals.values()], backgroundColor: ['#3b82f6', '#f97316', '#10b981', '#ef4444', '#8b5cf6'] }] }
    });
}
async function generateInsights() {
    const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)));
    const moy = total / nbJ;
    const insightsBox = document.getElementById('insightsBox');
    if (insightsBox) {
        insightsBox.innerHTML = `
            <p>📉 Moy/jour : <strong>${moy.toFixed(0)} F</strong></p>
            <p>💡 ${moy > 5000 ? 'Dépenses élevées' : 'Bon contrôle'}</p>`;
    }
}

// ==================== SAVE TRANSACTION FORM ====================
async function saveTransactionForm() {
    const form = document.getElementById('transactionForm');
    const mode = form.dataset.mode;
    const transId = form.dataset.transactionId;
    const amount = parseFloat(document.getElementById('transAmount')?.value || 0);
    const description = document.getElementById('transDescription')?.value || '';
    const type = document.getElementById('transType')?.value || 'expense';
    const date = document.getElementById('transDate')?.value;
    const accountId = document.getElementById('transAccount')?.value;
    const categoryId = document.getElementById('transCategory')?.value;

    if (!amount || !accountId || !date) {
        alert('Veuillez remplir tous les champs obligatoires');
        return;
    }

    const account = window.accountsMap?.get(accountId);
    const category = window.categoriesMap?.get(categoryId);

    if (mode === 'edit' && transId) {
        await executeInstruction({
            action: 'update_transaction',
            transaction_id: transId,
            fields_to_update: {
                amount,
                description,
                date,
                account: account?.name,
                category: category?.name
            }
        });
    } else {
        await executeInstruction({
            action: type === 'income' ? 'add_income' : 'add_expense',
            amount,
            description,
            category: category?.name || 'Autres',
            account: account?.name,
            date
        });
    }

    closeModal('transactionModal');
    await refreshDashboard();
}

// ==================== EVENT LISTENERS ====================
document.getElementById('loginBtn').onclick = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('applyCustomBtn').onclick = setPeriodeCustom;
document.querySelectorAll('.filter-btn').forEach(b => b.onclick = () => loadPeriod(b.dataset.period));

const manageCategoriesBtn = document.getElementById('manageCategoriesBtn');
if (manageCategoriesBtn) manageCategoriesBtn.onclick = function showCategoriesModal() { alert('Fonction à implémenter'); };
const addCategoryBtn = document.getElementById('addCategoryBtn');
if (addCategoryBtn) addCategoryBtn.onclick = function addCategory() { alert('Fonction à implémenter'); };
const addTransactionBtn = document.getElementById('addTransactionBtn');
if (addTransactionBtn) addTransactionBtn.onclick = () => window.openTransactionModal('add');
const manageAccountsBtn = document.getElementById('manageAccountsBtn');
if (manageAccountsBtn) manageAccountsBtn.onclick = function openAccountsModal() { alert('Fonction à implémenter'); };
const resetChatBtn = document.getElementById('resetChatBtn');
if (resetChatBtn) resetChatBtn.onclick = resetConversation;

document.querySelectorAll('.close').forEach(btn => btn.onclick = () => closeModal(btn.closest('.modal').id));
window.onclick = e => { if (e.target.classList.contains('modal')) e.target.style.display = 'none'; };
userInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// Sauvegarde des originaux pour les overrides
window._origUpdateBalances = updateBalancesDisplay;
window._origRefresh = refreshDashboard;
window.executeInstruction = executeInstruction;
window.saveTransactionForm = saveTransactionForm;

// Fonctions exposées globalement
window.deleteTransaction = async function(id) {
    if (!confirm('Supprimer cette transaction ?')) return;
    await executeInstruction({ action: 'delete_transaction', transaction_id: id });
    await refreshDashboard();
};
window.editTransaction = function(id) {
    window.openTransactionModal('edit', id);
};
window.closeModal = function(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'none';
};

checkAuth();
