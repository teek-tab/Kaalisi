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

// Limite de l'historique de conversation envoyé à l'API
const CONVERSATION_HISTORY_LIMIT = 20;

// DOM
const authScreen = document.getElementById('authScreen');
const dashboard = document.getElementById('dashboardScreen');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');

// ==================== VARIABLES GLOBALES POUR NAV.JS ====================
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

// FIX : regex isWriteAction resserrée — exclut les noms communs ("dépense", "revenu")
// qui peuvent apparaître dans des questions de lecture
function isWriteActionMessage(message) {
    return /\b(ajoute|ajouter|supprime|supprimer|modifie|modifier|transfert|transfère|épargne|corrige|annule)\b/i.test(message);
}

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
        let response;
        if (isWriteActionMessage(message)) {
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
            // FIX : fenêtre glissante sur l'historique pour éviter explosion tokens
            const historyToSend = conversationMessages.slice(-(CONVERSATION_HISTORY_LIMIT + 1), -1);
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser.id,
                    message: message,
                    history: historyToSend,
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
        const msg = response.message || 'Action effectuée.';
        addChatMessage('ai', msg);
        conversationMessages.push({ role: 'assistant', content: msg });

        // FIX : élagage de l'historique après ajout pour rester dans la limite
        if (conversationMessages.length > CONVERSATION_HISTORY_LIMIT) {
            conversationMessages = conversationMessages.slice(-CONVERSATION_HISTORY_LIMIT);
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
            const successMsg = result.successMessage || '✅ Action exécutée avec succès.';
            addChatMessage('ai', successMsg);
            conversationMessages.push({ role: 'assistant', content: successMsg });
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
            const msg = result.message || 'Action traitée.';
            addChatMessage('ai', msg);
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
        case 'delete_query':
            await handleDeleteQuery(action);
            break;
        case 'update_transaction':
            await handleUpdateTransaction(action);
            break;
        case 'update_query':
            await handleUpdateQuery(action);
            break;
        case 'add_to_savings':
            await handleAddToSavings(action);
            break;
        default:
            console.warn('Action non gérée:', action.action);
    }
}

// ==================== VALIDATION ====================
function validateAmount(amount, context = '') {
    if (!amount || isNaN(amount) || amount <= 0) {
        throw new Error(`Montant invalide${context ? ' pour ' + context : ''} : ${amount}`);
    }
}

// ==================== HELPERS DB ====================
function findCatId(categoryName) {
    if (!categoryName) return null;
    for (const [id, cat] of categoriesMap) {
        if (cat.name.toLowerCase() === categoryName.toLowerCase()) return id;
    }
    return null;
}

async function getOrCreateCatId(categoryName) {
    if (!categoryName) return null;
    const existing = findCatId(categoryName);
    if (existing) return existing;
    const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: categoryName, icon: '📌' }).select();
    if (data?.[0]) {
        categoriesMap.set(data[0].id, data[0]);
        return data[0].id;
    }
    return null;
}

function findAccId(accountName) {
    if (!accountName) return null;
    for (const [id, acc] of accountsMap) {
        if (acc.name === accountName) return id;
    }
    return null;
}

// ==================== HANDLERS DB ====================
async function handleAddTransaction(inst) {
    validateAmount(inst.amount, inst.description || inst.category);

    const catId = await getOrCreateCatId(inst.category);
    const accId = findAccId(inst.account);
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

    if (error || !data?.[0]) throw new Error('Erreur ajout transaction');

    lastCreatedTransactionId = data[0].id;
    const acc = accountsMap.get(accId);
    acc.balance = isIncome ? acc.balance + inst.amount : acc.balance - inst.amount;
    await db.from('accounts').update({ balance: acc.balance }).eq('id', accId);
    updateBalancesDisplay();
}

async function handleDeleteTransaction(inst) {
    const { data: t } = await db.from('transactions')
        .select('*')
        .eq('id', inst.transaction_id)
        .eq('user_id', currentUser.id)
        .single();

    if (!t) throw new Error('Transaction introuvable');

    const acc = accountsMap.get(t.account_id);
    if (acc) {
        acc.balance = t.type === 'income' ? acc.balance - t.amount : acc.balance + t.amount;
        await db.from('accounts').update({ balance: acc.balance }).eq('id', t.account_id);
        updateBalancesDisplay();
    }
    await db.from('transactions').delete().eq('id', inst.transaction_id).eq('user_id', currentUser.id);
}

// FIX : handleDeleteQuery — catId résolu une seule fois, pas de double boucle.
// FIX : suppression de l'appel à addChatMessage/refreshDashboard ici
//       (c'est handleConfirmationResponse qui s'en charge).
async function handleDeleteQuery(action) {
    const { query } = action;
    const filter = query.filter;

    // Résoudre catId une seule fois
    const catId = filter.category ? findCatId(filter.category) : null;

    let selectQuery = db.from('transactions')
        .select('id, account_id, type, amount')
        .eq('user_id', currentUser.id);

    if (filter.date) selectQuery = selectQuery.eq('date', filter.date);
    if (filter.type) selectQuery = selectQuery.eq('type', filter.type);
    if (catId)       selectQuery = selectQuery.eq('category_id', catId);

    const { data: transactions, error } = await selectQuery;
    if (error) throw new Error(`Erreur lecture : ${error.message}`);
    if (!transactions?.length) throw new Error('Aucune transaction trouvée');

    // Restaurer les soldes
    const balanceDelta = new Map();
    for (const t of transactions) {
        const delta = t.type === 'income' ? -t.amount : t.amount;
        balanceDelta.set(t.account_id, (balanceDelta.get(t.account_id) || 0) + delta);
    }
    for (const [accId, delta] of balanceDelta) {
        const acc = accountsMap.get(accId);
        if (acc) {
            acc.balance += delta;
            await db.from('accounts').update({ balance: acc.balance }).eq('id', accId);
        }
    }

    // Supprimer avec le même catId déjà résolu
    let deleteQuery = db.from('transactions').delete().eq('user_id', currentUser.id);
    if (filter.date) deleteQuery = deleteQuery.eq('date', filter.date);
    if (filter.type) deleteQuery = deleteQuery.eq('type', filter.type);
    if (catId)       deleteQuery = deleteQuery.eq('category_id', catId);

    const { error: deleteError } = await deleteQuery;
    if (deleteError) throw new Error(`Erreur suppression : ${deleteError.message}`);

    updateBalancesDisplay();
    // Pas de addChatMessage ni refreshDashboard ici — géré par handleConfirmationResponse
}

// FIX : handleUpdateQuery — même principe, pas de side-effects UI
async function handleUpdateQuery(action) {
    const { query } = action;
    const filter = query.filter;
    const update = query.update;

    const catId = filter.category ? findCatId(filter.category) : null;

    let selectQuery = db.from('transactions')
        .select('id')
        .eq('user_id', currentUser.id);

    if (filter.date) selectQuery = selectQuery.eq('date', filter.date);
    if (filter.type) selectQuery = selectQuery.eq('type', filter.type);
    if (catId)       selectQuery = selectQuery.eq('category_id', catId);

    const { data: transactions, error } = await selectQuery;
    if (error) throw new Error(`Erreur lecture : ${error.message}`);
    if (!transactions?.length) throw new Error('Aucune transaction trouvée');

    if (update.category) {
        const newCatId = await getOrCreateCatId(update.category);
        if (newCatId) {
            let updateQuery = db.from('transactions')
                .update({ category_id: newCatId })
                .eq('user_id', currentUser.id);
            if (filter.date) updateQuery = updateQuery.eq('date', filter.date);
            if (filter.type) updateQuery = updateQuery.eq('type', filter.type);
            if (catId)       updateQuery = updateQuery.eq('category_id', catId);
            await updateQuery;
        }
    }
    // Pas de side-effects UI ici
}

async function handleUpdateTransaction(inst) {
    const { data: t } = await db.from('transactions')
        .select('*')
        .eq('id', inst.transaction_id)
        .eq('user_id', currentUser.id)
        .single();

    if (!t) throw new Error('Transaction introuvable');

    const fields = inst.fields_to_update || {};
    const updates = {};
    if (fields.amount      !== undefined) updates.amount      = fields.amount;
    if (fields.description !== undefined) updates.description = fields.description;
    if (fields.date        !== undefined) updates.date        = fields.date;

    await db.from('transactions').update(updates).eq('id', inst.transaction_id);

    if (fields.amount !== undefined) {
        const acc = accountsMap.get(t.account_id);
        if (acc) {
            const delta = t.type === 'income' ? fields.amount - t.amount : t.amount - fields.amount;
            acc.balance += delta;
            await db.from('accounts').update({ balance: acc.balance }).eq('id', t.account_id);
            updateBalancesDisplay();
        }
    }
}

// FIX : handleAddToSavings — opération atomique via try/catch avec rollback manuel
async function handleAddToSavings(inst) {
    validateAmount(inst.amount, 'épargne');

    const src = inst.source || 'cash';
    const srcId = findAccId(src);
    const epId  = findAccId('epargne');

    if (!srcId) throw new Error(`Compte source "${src}" introuvable`);
    if (!epId)  throw new Error('Compte épargne introuvable');

    const srcAcc = accountsMap.get(srcId);
    const epAcc  = accountsMap.get(epId);

    if (srcAcc.balance < inst.amount) {
        throw new Error(`Solde insuffisant sur ${src} (${srcAcc.balance}F disponibles)`);
    }

    // Débit source
    srcAcc.balance -= inst.amount;
    const { error: e1 } = await db.from('accounts').update({ balance: srcAcc.balance }).eq('id', srcId);
    if (e1) {
        // Rollback mémoire
        srcAcc.balance += inst.amount;
        throw new Error(`Erreur débit ${src} : ${e1.message}`);
    }

    // Crédit épargne
    epAcc.balance += inst.amount;
    const { error: e2 } = await db.from('accounts').update({ balance: epAcc.balance }).eq('id', epId);
    if (e2) {
        // Rollback mémoire + DB pour la source
        srcAcc.balance += inst.amount;
        epAcc.balance  -= inst.amount;
        await db.from('accounts').update({ balance: srcAcc.balance }).eq('id', srcId);
        throw new Error(`Erreur crédit épargne : ${e2.message}`);
    }

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
    if (accounts) {
        accountsMap.clear();
        accounts.forEach(a => accountsMap.set(a.id, a));
        updateBalancesDisplay();
    }
    const { data: cats } = await db.from('categories').select('*').eq('user_id', currentUser.id);
    if (cats) {
        categoriesMap.clear();
        cats.forEach(c => categoriesMap.set(c.id, c));
    }
    window.accountsMap   = accountsMap;
    window.categoriesMap = categoriesMap;
}

function updateBalancesDisplay() {
    const balancesDiv = document.getElementById('balances');
    if (balancesDiv) {
        balancesDiv.innerHTML = Array.from(accountsMap.values())
            .map(a => `<span>${getEmoji(a.name)} ${a.name}: ${a.balance} F</span>`).join('');
    }
    const badge = document.getElementById('userEmailShort');
    if (badge && currentUser) badge.textContent = currentUser.email.split('@')[0];
    // nav.js surcharge cette fonction pour mettre à jour les cartes
}

function getEmoji(name) {
    return { cash: '💵', wave: '📱', epargne: '💰' }[name] || '🏦';
}

// ==================== PÉRIODE ====================
function getDateRange(period) {
    const now = new Date();
    if (period === 'week') {
        const s = new Date(now);
        s.setDate(now.getDate() - now.getDay());
        return { debut: s.toISOString().slice(0, 10), fin: now.toISOString().slice(0, 10) };
    } else if (period === 'month') {
        return {
            debut: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
            fin:   new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)
        };
    } else {
        return {
            debut: new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10),
            fin:   new Date(now.getFullYear(), 11, 31).toISOString().slice(0, 10)
        };
    }
}

async function loadPeriod(period) {
    currentPeriode = getDateRange(period);
    window.currentPeriode = currentPeriode;
    lastTransactionsLoad = { key: '', time: 0 };
    await refreshDashboard();
}
window.loadPeriod = loadPeriod;

async function refreshDashboard() {
    if (refreshPromise) return refreshPromise;
    
    refreshPromise = (async () => {
        try {
            // 1. Charger les données
            await loadTransactions();
            await loadUserData();
            
            // 2. Mettre à jour l'affichage principal (ACCUEIL)
            if (typeof renderHomeSummary === 'function') renderHomeSummary();
            if (typeof renderRecentTransactions === 'function') renderRecentTransactions();
            if (typeof renderAccountCards === 'function') renderAccountCards();
            
            // 3. Mettre à jour le tableau des transactions
            if (typeof updateTransactionsTable === 'function') updateTransactionsTable();
            
            // 4. Mettre à jour l'onglet STATS s'il est actif
            const statsTab = document.getElementById('tab-stats');
            if (statsTab && statsTab.classList.contains('active')) {
                if (typeof renderStatsTab === 'function') renderStatsTab();
            }
            
            // 5. Mettre à jour l'onglet PARAMÈTRES s'il est actif
            const settingsTab = document.getElementById('tab-settings');
            if (settingsTab && settingsTab.classList.contains('active')) {
                if (typeof renderSettingsTab === 'function') renderSettingsTab();
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
            document.getElementById('transAmount').value      = t.amount;
            document.getElementById('transDescription').value = t.description || '';
            if (typeof setTransType === 'function') setTransType(t.type);
            document.getElementById('transDate').value        = t.date;
            catSel.value = t.category_id || '';
            accSel.value = t.account_id  || '';
        }
    } else {
        form.reset();
        document.getElementById('transDate').value = new Date().toISOString().slice(0, 10);
        if (typeof setTransType === 'function') setTransType('expense');
    }
    if (typeof openModal === 'function') openModal('transactionModal');
};

async function saveTransactionForm() {
    const form      = document.getElementById('transactionForm');
    const mode      = form.dataset.mode;
    const transId   = form.dataset.transactionId;
    const amount    = parseFloat(document.getElementById('transAmount')?.value || 0);
    const description = document.getElementById('transDescription')?.value || '';
    const type      = document.getElementById('transType')?.value || 'expense';
    const date      = document.getElementById('transDate')?.value;
    const accountId = document.getElementById('transAccount')?.value;
    const categoryId = document.getElementById('transCategory')?.value;

    // FIX : validation montant dans le formulaire
    if (!amount || amount <= 0 || isNaN(amount)) {
        alert('Le montant doit être un nombre positif.');
        return;
    }
    if (!accountId || !date) {
        alert('Veuillez remplir tous les champs obligatoires.');
        return;
    }

    const account  = window.accountsMap?.get(accountId);
    const category = window.categoriesMap?.get(categoryId);

    try {
        if (mode === 'edit' && transId) {
            await executeRealAction({
                action: 'update_transaction',
                transaction_id: transId,
                fields_to_update: { amount, description, date }
            });
        } else {
            await executeRealAction({
                action: type === 'income' ? 'add_income' : 'add_expense',
                amount,
                description,
                category: category?.name || 'Autres',
                account: account?.name,
                date
            });
        }
        if (typeof closeModal === 'function') closeModal('transactionModal');
        await refreshDashboard();
    } catch (err) {
        alert('Erreur : ' + err.message);
    }
}

window.deleteTransaction = async function(id) {
    if (!confirm('Supprimer cette transaction ?')) return;
    try {
        await executeRealAction({ action: 'delete_transaction', transaction_id: id });
        await refreshDashboard();
    } catch (err) {
        alert('Erreur : ' + err.message);
    }
};

window.editTransaction = function(id) { window.openTransactionModal('edit', id); };

// ==================== INIT ====================
document.getElementById('loginBtn').onclick    = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick   = logout;
document.getElementById('sendBtn').onclick     = sendMessage;

document.getElementById('applyCustomBtn').onclick = () => {
    const debut = document.getElementById('dateDebut').value;
    const fin   = document.getElementById('dateFin').value;
    if (debut && fin) {
        currentPeriode = { debut, fin };
        window.currentPeriode = currentPeriode;
        lastTransactionsLoad = { key: '', time: 0 };
        refreshDashboard();
    }
};

document.getElementById('addTransactionBtn').onclick = () => window.openTransactionModal('add');
document.getElementById('resetChatBtn').onclick      = resetConversation;

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
        const next    = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
    });
}
