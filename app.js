// ==================== CONFIGURATION ====================
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
let conversationMessages = [];
let lastExecutedActions = [];

// Gestion confirmation
let pendingAction = null;
let waitingForConfirmation = false;

// Cache
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

// ==================== VARIABLES GLOBALES POUR COMPATIBILITÉ NAV.JS (AJOUT) ====================
window.balanceChartInstance = null;
window.expensesChartInstance = null;

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
    else alert('Inscription réussie ! Connectez-vous.');
}

async function logout() { await db.auth.signOut(); window.location.reload(); }

async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        window.currentUser = currentUser;
        authScreen.style.display = 'none';
        dashboard.style.display = 'block';
        await loadUserData(true);
        await loadPeriod('month');
        resetConversation();
        addChatMessage('system', '🟢 Connecté ! Je demande confirmation avant chaque action.');
    } else {
        authScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// ==================== AFFICHAGE ====================
function addChatMessage(sender, text) {
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'user-msg' : (sender === 'ai' ? 'ai-msg' : 'system-msg');
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function resetConversation() {
    conversationMessages = [];
    pendingAction = null;
    waitingForConfirmation = false;
    chatMessages.innerHTML = '';
    addChatMessage('system', '🔄 Nouvelle conversation. Je demande confirmation avant chaque action.');
}

function getActionDescription(inst) {
    if (Array.isArray(inst)) {
        if (inst.length === 0) return "Aucune action";
        if (inst.length === 1) return getActionDescription(inst[0]);
        return `${inst.length} actions :\n${inst.map((a, i) => `  ${i+1}. ${getActionDescription(a)}`).join('\n')}`;
    }
    switch (inst.action) {
        case 'add_expense': return `Ajouter ${inst.amount}F pour ${inst.description || inst.category || '?'} (${inst.category || 'Autres'}) sur ${inst.account || 'cash'}`;
        case 'add_income': return `Ajouter ${inst.amount}F de revenu (${inst.category || 'Autres'}) sur ${inst.account || 'cash'}`;
        case 'add_to_savings': return `Transférer ${inst.amount}F vers l'épargne depuis ${inst.source || 'cash'}`;
        case 'delete_transaction': return `Supprimer la transaction${inst.transaction_id ? ` #${inst.transaction_id.slice(-4)}` : ''}`;
        case 'delete_query': return `Supprimer ${inst.query?.filter?.category ? `les ${inst.query.filter.category}` : 'les transactions'} du ${inst.query?.filter?.date || '?'}`;
        case 'update_transaction': return `Modifier la transaction${inst.transaction_id ? ` #${inst.transaction_id.slice(-4)}` : ''}`;
        case 'update_query': return `Re-catégoriser les transactions du ${inst.query?.filter?.date || '?'} en "${inst.query?.update?.category || '?'}"`;
        default: return inst.action || 'Action';
    }
}

// ==================== MESSAGERIE ====================
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    addChatMessage('user', message);
    userInput.value = '';

    if (waitingForConfirmation && pendingAction) {
        await handleConfirmationResponse(message);
        return;
    }

    conversationMessages.push({ role: 'user', content: message });

    const tempDiv = document.createElement('div');
    tempDiv.className = 'ai-msg';
    tempDiv.textContent = '🤔 Analyse...';
    chatMessages.appendChild(tempDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const isWriteAction = message.match(/\b(ajoute|ajouter|dépense|dépenser|revenu|supprime|supprimer|modifie|modifier|transfert|épargne|corrige|annule)\b/i);
        
        let response;
        if (isWriteAction) {
            const res = await fetch('/api/chat?type=understand', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser.id,
                    message: message,
                    recentActions: lastExecutedActions,
                    accounts: Array.from(accountsMap.values()),
                    categories: Array.from(categoriesMap.values()),
                    currentDate: new Date().toISOString().split('T')[0]
                })
            });
            response = await res.json();
        } else {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser.id,
                    message: message,
                    history: conversationMessages.slice(0, -1),
                    periode: currentPeriode,
                    accounts: Array.from(accountsMap.values()),
                    categories: Array.from(categoriesMap.values()),
                    transactions: transactionsData,
                    currentDate: new Date().toISOString().split('T')[0]
                })
            });
            response = await res.json();
        }
        
        tempDiv.remove();

        // Actions multiples
        if (response.actions && Array.isArray(response.actions)) {
            pendingAction = response.actions;
            waitingForConfirmation = true;
            const confirmMsg = response.confirmationMessage || `💰 Confirmer ${response.actions.length} actions ? (oui/non/modifier)`;
            addChatMessage('ai', confirmMsg);
            conversationMessages.push({ role: 'assistant', content: confirmMsg });
            return;
        }
        
        // Action unique avec confirmation
        if (response.requiresConfirmation === true && response.action) {
            pendingAction = response;
            waitingForConfirmation = true;
            const confirmMsg = response.confirmationMessage || `💰 Confirmer : ${getActionDescription(response)} ? (oui/non/modifier)`;
            addChatMessage('ai', confirmMsg);
            conversationMessages.push({ role: 'assistant', content: confirmMsg });
            return;
        }
        
        // Réponse simple
        if (response.action === 'answer' && response.message) {
            addChatMessage('ai', response.message);
            conversationMessages.push({ role: 'assistant', content: response.message });
        } else if (response.action === 'clarify') {
            addChatMessage('ai', response.message);
            conversationMessages.push({ role: 'assistant', content: response.message });
        } else {
            addChatMessage('ai', response.message || 'Action effectuée.');
            conversationMessages.push({ role: 'assistant', content: response.message || 'Action effectuée.' });
        }

    } catch (err) {
        tempDiv.remove();
        addChatMessage('ai', '❌ Erreur de connexion. Réessayez.');
        console.error(err);
    }
}

async function handleConfirmationResponse(response) {
    const tempDiv = document.createElement('div');
    tempDiv.className = 'ai-msg';
    tempDiv.textContent = '⏳ Traitement...';
    chatMessages.appendChild(tempDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const res = await fetch('/api/chat?type=execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                pendingAction: pendingAction,
                userResponse: response,
                accounts: Array.from(accountsMap.values()),
                currentDate: new Date().toISOString().split('T')[0]
            })
        });

        const result = await res.json();
        tempDiv.remove();

        if (result.actionExecuted) {
            await executeRealAction(result.actionExecuted);
            
            if (!Array.isArray(result.actionExecuted)) {
                lastExecutedActions.unshift({
                    action: result.actionExecuted.action,
                    transaction_id: lastCreatedTransactionId,
                    amount: result.actionExecuted.amount,
                    timestamp: Date.now()
                });
                if (lastExecutedActions.length > 5) lastExecutedActions.pop();
            }
            
            await refreshDashboard();
            addChatMessage('ai', result.successMessage || '✅ Action exécutée avec succès.');
            conversationMessages.push({ role: 'assistant', content: result.successMessage || '✅ Action exécutée.' });
            waitingForConfirmation = false;
            pendingAction = null;
            
        } else if (result.updatedAction) {
            pendingAction = result.updatedAction;
            addChatMessage('ai', result.newConfirmationMessage);
            conversationMessages.push({ role: 'assistant', content: result.newConfirmationMessage });
            
        } else if (result.cancelled) {
            addChatMessage('ai', '❌ Action annulée.');
            conversationMessages.push({ role: 'assistant', content: 'Action annulée.' });
            waitingForConfirmation = false;
            pendingAction = null;
            
        } else {
            addChatMessage('ai', result.message || 'Action traitée.');
            waitingForConfirmation = false;
            pendingAction = null;
        }
        
    } catch (err) {
        tempDiv.remove();
        addChatMessage('ai', '❌ Erreur lors de l\'exécution.');
        console.error(err);
        waitingForConfirmation = false;
        pendingAction = null;
    }
}

// ==================== EXÉCUTION DB ====================
async function executeRealAction(action) {
    // Actions multiples
    if (Array.isArray(action)) {
        for (const singleAction of action) {
            await executeRealAction(singleAction);
        }
        return;
    }
    
    console.log('🎯 Exécution:', action.action);
    
    switch (action.action) {
        case 'add_expense':
        case 'add_income':
            await handleAddTransaction(action);
            break;
        case 'delete_transaction':
            await handleDeleteTransaction(action);
            break;
        case 'delete_query':                    // ✅ AJOUT
            await handleDeleteQuery(action);
            break;
        case 'update_transaction':
            await handleUpdateTransaction(action);
            break;
        case 'update_query':                    // ✅ AJOUT
            await handleUpdateQuery(action);
            break;
        case 'add_to_savings':
            await handleAddToSavings(action);
            break;
        default:
            console.warn('Action non gérée:', action.action);
    }
}

async function handleAddTransaction(inst) {
    let catId = null;
    for (let [id, cat] of categoriesMap) {
        if (cat.name.toLowerCase() === (inst.category || '').toLowerCase()) {
            catId = id;
            break;
        }
    }
    if (!catId && inst.category) {
        const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: inst.category, icon: '📌' }).select();
        if (data?.[0]) {
            catId = data[0].id;
            categoriesMap.set(catId, data[0]);
        }
    }
    
    let accId = null;
    for (let [id, acc] of accountsMap) {
        if (acc.name === inst.account) {
            accId = id;
            break;
        }
    }
    if (!accId) throw new Error(`Compte "${inst.account}" introuvable`);
    
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
    } else {
        throw new Error('Erreur ajout transaction');
    }
}

async function handleDeleteTransaction(inst) {
    const transId = inst.transaction_id;
    const { data: t } = await db.from('transactions')
        .select('*')
        .eq('id', transId)
        .eq('user_id', currentUser.id)
        .single();
    
    if (!t) throw new Error('Transaction introuvable');
    
    const acc = accountsMap.get(t.account_id);
    if (acc) {
        const newBal = t.type === 'income' ? acc.balance - t.amount : acc.balance + t.amount;
        await db.from('accounts').update({ balance: newBal }).eq('id', t.account_id);
        acc.balance = newBal;
        updateBalancesDisplay();
    }
    await db.from('transactions').delete().eq('id', transId).eq('user_id', currentUser.id);
}

// ==================== NOUVELLES FONCTIONS POUR DELETE_QUERY ET UPDATE_QUERY (AJOUT) ====================

async function handleDeleteQuery(action) {
    const { query } = action;
    const filter = query.filter;
    
    let dbQuery = db.from('transactions').select('*, accounts(name, balance)').eq('user_id', currentUser.id);
    
    if (filter.date) dbQuery = dbQuery.eq('date', filter.date);
    if (filter.type) dbQuery = dbQuery.eq('type', filter.type);
    if (filter.category) {
        let catId = null;
        for (let [id, cat] of categoriesMap) {
            if (cat.name.toLowerCase() === filter.category.toLowerCase()) {
                catId = id;
                break;
            }
        }
        if (catId) dbQuery = dbQuery.eq('category_id', catId);
    }
    
    const { data: transactions, error } = await dbQuery;
    if (error) throw new Error(`Erreur: ${error.message}`);
    if (!transactions || transactions.length === 0) {
        throw new Error('Aucune transaction trouvée');
    }
    
    // Restaurer les soldes
    for (const t of transactions) {
        const acc = accountsMap.get(t.account_id);
        if (acc) {
            if (t.type === 'income') {
                acc.balance -= t.amount;
            } else {
                acc.balance += t.amount;
            }
            await db.from('accounts').update({ balance: acc.balance }).eq('id', t.account_id);
        }
    }
    
    // Supprimer
    let deleteQuery = db.from('transactions').delete().eq('user_id', currentUser.id);
    if (filter.date) deleteQuery = deleteQuery.eq('date', filter.date);
    if (filter.type) deleteQuery = deleteQuery.eq('type', filter.type);
    if (filter.category) {
        let catId = null;
        for (let [id, cat] of categoriesMap) {
            if (cat.name.toLowerCase() === filter.category.toLowerCase()) {
                catId = id;
                break;
            }
        }
        if (catId) deleteQuery = deleteQuery.eq('category_id', catId);
    }
    
    const { error: deleteError } = await deleteQuery;
    if (deleteError) throw new Error(`Erreur suppression: ${deleteError.message}`);
    
    updateBalancesDisplay();
    await refreshDashboard();
    addChatMessage('ai', `✅ ${transactions.length} transaction(s) supprimée(s).`);
}

async function handleUpdateQuery(action) {
    const { query } = action;
    const filter = query.filter;
    const update = query.update;
    
    let dbQuery = db.from('transactions').select('id, account_id, type, amount').eq('user_id', currentUser.id);
    
    if (filter.date) dbQuery = dbQuery.eq('date', filter.date);
    if (filter.type) dbQuery = dbQuery.eq('type', filter.type);
    if (filter.category) {
        let catId = null;
        for (let [id, cat] of categoriesMap) {
            if (cat.name.toLowerCase() === filter.category.toLowerCase()) {
                catId = id;
                break;
            }
        }
        if (catId) dbQuery = dbQuery.eq('category_id', catId);
    }
    
    const { data: transactions, error } = await dbQuery;
    if (error) throw new Error(`Erreur: ${error.message}`);
    if (!transactions || transactions.length === 0) {
        throw new Error('Aucune transaction trouvée');
    }
    
    // Appliquer la mise à jour
    if (update.category) {
        let newCatId = null;
        for (let [id, cat] of categoriesMap) {
            if (cat.name.toLowerCase() === update.category.toLowerCase()) {
                newCatId = id;
                break;
            }
        }
        if (!newCatId) {
            const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: update.category, icon: '📌' }).select();
            if (data?.[0]) newCatId = data[0].id;
            if (newCatId) categoriesMap.set(newCatId, data[0]);
        }
        
        if (newCatId) {
            let updateQuery = db.from('transactions').update({ category_id: newCatId }).eq('user_id', currentUser.id);
            if (filter.date) updateQuery = updateQuery.eq('date', filter.date);
            if (filter.type) updateQuery = updateQuery.eq('type', filter.type);
            await updateQuery;
        }
    }
    
    await refreshDashboard();
    addChatMessage('ai', `✅ ${transactions.length} transaction(s) modifiée(s).`);
}

async function handleUpdateTransaction(inst) {
    const transId = inst.transaction_id;
    const { data: t } = await db.from('transactions')
        .select('*')
        .eq('id', transId)
        .eq('user_id', currentUser.id)
        .single();
    
    if (!t) throw new Error('Transaction introuvable');
    
    const fields = inst.fields_to_update || {};
    const updates = {};
    if (fields.amount !== undefined) updates.amount = fields.amount;
    if (fields.description !== undefined) updates.description = fields.description;
    if (fields.date !== undefined) updates.date = fields.date;
    
    await db.from('transactions').update(updates).eq('id', transId);
    
    const acc = accountsMap.get(t.account_id);
    if (acc && fields.amount !== undefined) {
        const oldAmount = t.amount;
        const delta = t.type === 'income' ? fields.amount - oldAmount : oldAmount - fields.amount;
        acc.balance += delta;
        await db.from('accounts').update({ balance: acc.balance }).eq('id', t.account_id);
        updateBalancesDisplay();
    }
}

async function handleAddToSavings(inst) {
    const src = inst.source || 'cash';
    let srcId = null, epId = null;
    for (let [id, a] of accountsMap) {
        if (a.name === src) srcId = id;
        if (a.name === 'epargne') epId = id;
    }
    if (!srcId || !epId) throw new Error('Compte introuvable');
    
    const srcAcc = accountsMap.get(srcId);
    const epAcc = accountsMap.get(epId);
    if (srcAcc.balance < inst.amount) throw new Error(`Solde ${src} insuffisant`);
    
    await db.from('accounts').update({ balance: srcAcc.balance - inst.amount }).eq('id', srcId);
    await db.from('accounts').update({ balance: epAcc.balance + inst.amount }).eq('id', epId);
    srcAcc.balance -= inst.amount;
    epAcc.balance += inst.amount;
    updateBalancesDisplay();
}

// ==================== DONNÉES ====================
async function loadUserData(force = false) {
    const now = Date.now();
    if (!force && now - lastUserDataLoad < USER_DATA_CACHE_MS && accountsMap.size > 0 && categoriesMap.size > 0) {
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
    const balancesDiv = document.getElementById('balances');
    if (balancesDiv) {
        balancesDiv.innerHTML = Array.from(accountsMap.values()).map(a => `<span>${getEmoji(a.name)} ${a.name}: ${a.balance} F</span>`).join('');
    }
    const badge = document.getElementById('userEmailShort');
    if (badge && currentUser) badge.textContent = currentUser.email.split('@')[0];
    renderAccountCards();
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
    lastTransactionsLoad = { key: '', time: 0 };
    await refreshDashboard();
}

async function refreshDashboard() {
    if (refreshPromise) return refreshPromise;
    
    refreshPromise = (async () => {
        try {
            await loadTransactions();
            await loadUserData();
            renderHomeSummary();
            renderRecentTransactions();
            updateTransactionsTable();
            if (document.getElementById('tab-stats')?.classList.contains('active')) {
                renderStatsTab();
            }
            if (document.getElementById('tab-settings')?.classList.contains('active')) {
                renderSettingsTab();
            }
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
    const net = income - expense;
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / 86400000));
    const avg = expense / nbJ;
    
    setEl('homeExpense', expense);
    setEl('homeIncome', income);
    const netEl = document.getElementById('homeNet');
    if (netEl) {
        netEl.textContent = (net >= 0 ? '+' : '') + fmt(net);
        netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
    }
    setEl('homeAvg', avg);
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
    const cat = t.categories || { name: 'Autres', icon: '📦' };
    const acc = t.accounts || { name: '?' };
    const sign = t.type === 'expense' ? '-' : '+';
    const cls = t.type === 'expense' ? 'expense' : 'income';
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
    const container = document.getElementById('transactionsTableBody');
    const paginationDiv = document.getElementById('transactionsPagination');
    if (!container) return;
    
    let filtered = [...(window.transactionsData || [])];
    const ft = window.filterType || 'all';
    if (ft === 'expense') filtered = filtered.filter(t => t.type === 'expense');
    if (ft === 'income') filtered = filtered.filter(t => t.type === 'income');
    
    const rpp = window.rowsPerPage || 10;
    const totalPages = Math.ceil(filtered.length / rpp) || 1;
    if (window.currentPage > totalPages) window.currentPage = 1;
    const start = ((window.currentPage || 1) - 1) * rpp;
    const rows = filtered.slice(start, start + rpp);
    
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
                <button class="page-btn" onclick="changePage(1)" ${(window.currentPage||1) >= totalPages ? 'disabled' : ''}>▶</button>
            </div>`;
    }
}

function setFilterType(type) {
    window.filterType = type;
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
    const total = Math.ceil(count / (window.rowsPerPage || 10));
    const newPage = (window.currentPage || 1) + delta;
    if (newPage >= 1 && newPage <= total) { window.currentPage = newPage; updateTransactionsTable(); }
};

// ==================== ONGLET STATS ====================
let balanceChartInstance = null;
let expensesChartInstance = null;

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
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / 86400000));
    
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
    if (expensesChartInstance) expensesChartInstance.destroy();
    if (!totals.size) return;
    expensesChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [...totals.keys()],
            datasets: [{ data: [...totals.values()], backgroundColor: ['#00d68f','#ff5370','#4d9fff','#ffb547','#c084fc'] }]
        },
        options: { cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: '#9aa3b8', font: { size: 11 } } } } }
    });
}

function renderBalanceCurve() {
    const ctx = document.getElementById('balanceChart');
    if (!ctx) return;
    const txs = [...(window.transactionsData || [])].sort((a,b) => new Date(a.date) - new Date(b.date));
    if (!txs.length) return;
    const byDate = new Map();
    txs.forEach(t => {
        const d = t.date;
        const delta = t.type === 'income' ? t.amount : -t.amount;
        byDate.set(d, (byDate.get(d) || 0) + delta);
    });
    const dates = [...byDate.keys()].sort();
    let running = 0;
    const values = dates.map(d => { running += byDate.get(d); return running; });
    if (balanceChartInstance) balanceChartInstance.destroy();
    balanceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates.map(d => d.slice(5)),
            datasets: [{ label: 'Solde net', data: values, borderColor: '#00d68f', backgroundColor: 'rgba(0,214,143,0.08)', borderWidth: 2, pointRadius: 3, fill: true, tension: 0.35 }]
        },
        options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#5a6277' } }, y: { ticks: { color: '#5a6277' } } } }
    });
}

async function renderComparison() {
    const el = document.getElementById('compareCard');
    if (!el || !window.currentPeriode) return;
    const debut = new Date(window.currentPeriode.debut);
    const fin = new Date(window.currentPeriode.fin);
    const diff = fin - debut;
    const prevDebut = new Date(debut - diff - 86400000).toISOString().slice(0,10);
    const prevFin = new Date(debut - 86400000).toISOString().slice(0,10);
    
    try {
        const { data: prev } = await db.from('transactions')
            .select('amount,type')
            .eq('user_id', currentUser.id)
            .gte('date', prevDebut)
            .lte('date', prevFin);
        let prevExp = 0, prevInc = 0;
        (prev || []).forEach(t => { if (t.type === 'expense') prevExp += t.amount; else prevInc += t.amount; });
        let curExp = 0, curInc = 0;
        (window.transactionsData || []).forEach(t => { if (t.type === 'expense') curExp += t.amount; else curInc += t.amount; });
        const expDelta = prevExp ? Math.round((curExp - prevExp) / prevExp * 100) : null;
        const incDelta = prevInc ? Math.round((curInc - prevInc) / prevInc * 100) : null;
        el.innerHTML = `
            <div class="compare-row"><span class="compare-label">💸 Dépenses</span><span class="compare-val">${fmt(curExp)} F</span>${deltaTag(expDelta, true)}</div>
            <div class="compare-row"><span class="compare-label">💰 Revenus</span><span class="compare-val">${fmt(curInc)} F</span>${deltaTag(incDelta, false)}</div>`;
    } catch(e) {
        el.innerHTML = '<div class="empty-state">Impossible de charger la comparaison</div>';
    }
}

function deltaTag(pct, inverse) {
    if (pct === null) return `<span class="compare-delta delta-neutral">—</span>`;
    const isUp = pct > 0;
    const isBad = inverse ? isUp : !isUp;
    const cls = pct === 0 ? 'delta-neutral' : isBad ? 'delta-up' : 'delta-down';
    return `<span class="compare-delta ${cls}">${pct > 0 ? '+' : ''}${pct}%</span>`;
}

async function generateInsights() {
    const el = document.getElementById('insightsContent');
    if (!el) return;
    const txs = window.transactionsData || [];
    if (!txs.length) { el.innerHTML = '<p>Aucune donnée pour cette période.</p>'; return; }
    let expense = 0;
    const catMap = new Map();
    txs.forEach(t => {
        if (t.type === 'expense') {
            expense += t.amount;
            const n = t.categories?.name || 'Autres';
            catMap.set(n, (catMap.get(n) || 0) + t.amount);
        }
    });
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / 86400000));
    const avg = expense / nbJ;
    const topCat = [...catMap.entries()].sort((a,b) => b[1]-a[1])[0];
    el.innerHTML = `
        <p>📉 Moyenne/jour : <strong>${fmt(avg)} F</strong></p>
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
    const items = Array.from(window.accountsMap.values());
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
    const el = document.getElementById('categoriesListSettings');
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
        await db.from('accounts').update({ name: newName }).eq('id', id);
        await refreshDashboard();
        renderSettingsTab();
    }
};

window.deleteAccountSettings = async (id) => {
    const acc = window.accountsMap?.get(id);
    if (!acc || !confirm(`Supprimer "${acc.name}" ?`)) return;
    await db.from('accounts').delete().eq('id', id).eq('user_id', currentUser.id);
    window.accountsMap.delete(id);
    renderAccountCards();
    renderSettingsTab();
    await refreshDashboard();
};

window.deleteCategorySettings = async (id) => {
    const cat = window.categoriesMap?.get(id);
    if (!cat || !confirm(`Supprimer "${cat.name}" ?`)) return;
    await db.from('categories').delete().eq('id', id).eq('user_id', currentUser.id);
    window.categoriesMap.delete(id);
    renderCategoriesSettings();
};

// ==================== HELPERS ====================
function fmt(n) { return Math.round(n).toLocaleString('fr'); }
function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = fmt(val) + ' F'; }

function openModal(id) { const m = document.getElementById(id); if (m) m.classList.add('open'); }
window.closeModal = function(id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); };

function setTransType(value) {
    document.getElementById('transType').value = value;
    document.querySelectorAll('.type-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === value);
    });
}

function loadPeriodStats(period) {
    document.querySelectorAll('#tab-stats .pill').forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
    });
    loadPeriod(period).then(() => renderStatsTab());
}

function exportCSV() {
    const txs = window.transactionsData || [];
    if (!txs.length) { alert('Aucune transaction à exporter.'); return; }
    const header = ['Date', 'Type', 'Montant (F)', 'Catégorie', 'Compte', 'Description'];
    const rows = txs.map(t => [
        t.date, t.type === 'expense' ? 'Dépense' : 'Revenu', t.amount,
        t.categories?.name || 'Autres', t.accounts?.name || '?',
        (t.description || '').replace(/,/g, ';')
    ]);
    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kaalisi_export_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

// ==================== MODAL TRANSACTIONS ====================
window.openTransactionModal = function(mode = 'add', id = null) {
    const title = document.getElementById('transactionModalTitle');
    if (title) title.textContent = mode === 'edit' ? 'Modifier transaction' : 'Ajouter transaction';
    const form = document.getElementById('transactionForm');
    form.dataset.mode = mode;
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
            document.getElementById('transAmount').value = t.amount;
            document.getElementById('transDescription').value = t.description || '';
            setTransType(t.type);
            document.getElementById('transDate').value = t.date;
            catSel.value = t.category_id || '';
            accSel.value = t.account_id || '';
        }
    } else {
        document.getElementById('transactionForm').reset();
        document.getElementById('transDate').value = new Date().toISOString().slice(0,10);
        setTransType('expense');
    }
    openModal('transactionModal');
};

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
        await executeRealAction({
            action: 'update_transaction',
            transaction_id: transId,
            fields_to_update: { amount, description, date }
        });
    } else {
        await executeRealAction({
            action: type === 'income' ? 'add_income' : 'add_expense',
            amount, description, category: category?.name || 'Autres', account: account?.name, date
        });
    }
    
    closeModal('transactionModal');
    await refreshDashboard();
}

window.deleteTransaction = async function(id) {
    if (!confirm('Supprimer cette transaction ?')) return;
    await executeRealAction({ action: 'delete_transaction', transaction_id: id });
    await refreshDashboard();
};

window.editTransaction = function(id) { window.openTransactionModal('edit', id); };

// ==================== SWITCH TAB & OVERRIDES ====================
window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const tabEl = document.getElementById('tab-' + tabName);
    const navBtn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
    if (tabEl) tabEl.classList.add('active');
    if (navBtn) navBtn.classList.add('active');
    if (tabName === 'stats') renderStatsTab();
    if (tabName === 'settings') renderSettingsTab();
    if (tabName === 'home') renderRecentTransactions();
};

window.updateTransactionsTable = updateTransactionsTable;

// ==================== INIT ====================
document.getElementById('loginBtn').onclick = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('applyCustomBtn').onclick = () => {
    const debut = document.getElementById('dateDebut').value;
    const fin = document.getElementById('dateFin').value;
    if (debut && fin) { currentPeriode = { debut, fin }; window.currentPeriode = currentPeriode; refreshDashboard(); }
};
document.getElementById('addTransactionBtn').onclick = () => window.openTransactionModal('add');
document.getElementById('resetChatBtn').onclick = resetConversation;
document.getElementById('openAddAccountBtn')?.addEventListener('click', () => openModal('addAccountModal'));
document.getElementById('openAddCategoryBtn')?.addEventListener('click', () => openModal('addCategoryModal'));

document.getElementById('addAccountBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newAccountName').value.trim().toLowerCase().replace(/\s+/g,'_');
    const balance = parseFloat(document.getElementById('newAccountBalance').value) || 0;
    if (!name) return;
    await db.from('accounts').insert({ user_id: currentUser.id, name, balance });
    await refreshDashboard();
    closeModal('addAccountModal');
    renderSettingsTab();
});

document.getElementById('addCategoryBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newCategoryName').value.trim();
    const icon = document.getElementById('newCategoryIcon').value.trim() || '📌';
    if (!name || !currentUser) return;
    await db.from('categories').insert({ user_id: currentUser.id, name, icon });
    await refreshDashboard();
    closeModal('addCategoryModal');
    renderSettingsTab();
});

userInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

checkAuth();

// Thème
const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeToggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
    themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
    });
}
