// ==================== CONFIGURATION ====================
const SUPABASE_URL = 'https://vsvvtyjbdrldlcswujzg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzdnZ0eWpiZHJsZGxjc3d1anpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDUyNTEsImV4cCI6MjA5MjcyMTI1MX0.YgkmLIoPJi3FQI6LvBVudB76LkMjR2Jywr8SZjNj1no';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentPeriode = { debut: '', fin: '' };
let categoriesMap = new Map();
let accountsMap = new Map();
let transactionsData = [];
let lastCreatedTransactionId = null; // Pour les corrections rapides

// Éléments DOM
const authScreen = document.getElementById('authScreen');
const dashboard = document.getElementById('dashboardScreen');
const userEmailSpan = document.getElementById('userEmail');
const balancesDiv = document.getElementById('balances');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const statsContainer = document.getElementById('statsContainer');
const transactionsListDiv = document.getElementById('transactionsList');
let expensesChart = null;

// ==================== AUTHENTIFICATION ====================
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

async function logout() {
    await db.auth.signOut();
    window.location.reload();
}

async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        authScreen.style.display = 'none';
        dashboard.style.display = 'block';
        userEmailSpan.textContent = currentUser.email;
        await loadUserData();
        await loadPeriod('month');
        addChatMessage('system', '🟢 Connecté ! Vous pouvez parler.');
    } else {
        authScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// ==================== CHARGEMENT DONNÉES UTILISATEUR ====================
async function loadUserData() {
    const { data: accounts, error: accErr } = await db
        .from('accounts')
        .select('*')
        .eq('user_id', currentUser.id);
    if (!accErr) {
        accountsMap.clear();
        accounts.forEach(acc => accountsMap.set(acc.id, acc));
        updateBalancesDisplay();
    }
    const { data: cats, error: catErr } = await db
        .from('categories')
        .select('*')
        .eq('user_id', currentUser.id);
    if (!catErr) {
        categoriesMap.clear();
        cats.forEach(c => categoriesMap.set(c.id, c));
    }
}

function updateBalancesDisplay() {
    let html = '';
    for (let acc of accountsMap.values()) {
        html += `<span>${getAccountEmoji(acc.name)} ${acc.name}: ${acc.balance} F</span>`;
    }
    balancesDiv.innerHTML = html;
}

function getAccountEmoji(name) {
    const map = { cash: '💵', wave: '📱', epargne: '💰' };
    return map[name] || '🏦';
}

// ==================== GESTION PÉRIODE ====================
function getDateRange(period) {
    const now = new Date();
    let debut, fin;
    if (period === 'week') {
        const start = new Date(now);
        start.setDate(now.getDate() - now.getDay());
        debut = start.toISOString().split('T')[0];
        fin = now.toISOString().split('T')[0];
    } else if (period === 'month') {
        debut = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        fin = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    } else if (period === 'year') {
        debut = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
        fin = new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0];
    }
    return { debut, fin };
}

async function loadPeriod(period) {
    const range = getDateRange(period);
    currentPeriode = range;
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.filter-btn[data-period="${period}"]`)?.classList.add('active');
    await refreshDashboard();
}

async function setPeriodeCustom() {
    const debut = document.getElementById('dateDebut').value;
    const fin = document.getElementById('dateFin').value;
    if (debut && fin) {
        currentPeriode = { debut, fin };
        await refreshDashboard();
    }
}

async function refreshDashboard() {
    await loadTransactions();
    updateStats();
    updateChart();
    updateTransactionsList();
    await generateInsights();
}

// ==================== CHARGEMENT TRANSACTIONS ====================
async function loadTransactions() {
    const { data, error } = await db
        .from('transactions')
        .select('*, categories(name, icon), accounts(name)')
        .eq('user_id', currentUser.id)
        .gte('date', currentPeriode.debut)
        .lte('date', currentPeriode.fin)
        .order('date', { ascending: false });
    if (!error) transactionsData = data || [];
    else console.error(error);
}

// ==================== STATS & GRAPHIQUES ====================
function updateStats() {
    let total = 0, income = 0;
    transactionsData.forEach(t => {
        if (t.type === 'expense') total += t.amount;
        if (t.type === 'income') income += t.amount;
    });
    const nbJours = Math.max(1, Math.ceil(
        (new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)
    ));
    const avgPerDay = total / nbJours;
    statsContainer.innerHTML = `
        <div class="stat-card"><h3>💰 Dépenses totales</h3><div class="stat-number">${total.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📈 Revenus</h3><div class="stat-number">${income.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📊 Moyenne/jour</h3><div class="stat-number">${avgPerDay.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📅 Nb transactions</h3><div class="stat-number">${transactionsData.length}</div></div>
    `;
}

function updateChart() {
    const ctx = document.getElementById('expensesChart').getContext('2d');
    const catTotals = new Map();
    transactionsData.forEach(t => {
        if (t.type === 'expense') {
            const catName = t.categories?.name || 'Sans catégorie';
            catTotals.set(catName, (catTotals.get(catName) || 0) + t.amount);
        }
    });
    const labels = Array.from(catTotals.keys());
    const data = Array.from(catTotals.values());
    if (expensesChart) expensesChart.destroy();
    expensesChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: ['#3b82f6', '#f97316', '#10b981', '#ef4444', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899'] }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}

function updateTransactionsList() {
    if (!transactionsData.length) {
        transactionsListDiv.innerHTML = '<div class="transaction-item">Aucune transaction sur cette période</div>';
        return;
    }
    transactionsListDiv.innerHTML = transactionsData.slice(0, 15).map(t => {
        const cat = t.categories || { name: 'Autres', icon: '📦' };
        const account = t.accounts || { name: 'cash' };
        return `
            <div class="transaction-item" data-id="${t.id}">
                <div>
                    <strong>${t.date}</strong> ${cat.icon} ${cat.name}
                    ${t.description ? ' - ' + t.description : ''}
                    <br><small>${account.name}</small>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-weight:bold;color:${t.type === 'expense' ? '#ef4444' : '#10b981'}">
                        ${t.type === 'expense' ? '-' : '+'} ${t.amount} F
                    </span>
                    <button class="btn-icon" onclick="editTransaction('${t.id}')" title="Modifier">✏️</button>
                    <button class="btn-icon" onclick="deleteTransaction('${t.id}')" title="Supprimer">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

// ==================== IA : APPEL BACKEND ====================
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;
    addChatMessage('user', message);
    userInput.value = '';

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                userId: currentUser.id,
                periode: currentPeriode
            })
        });
        const instruction = await response.json();
        await executeInstruction(instruction);
    } catch (err) {
        addChatMessage('ai', '❌ Erreur de connexion IA. Réessayez.');
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
            case 'query':
                await handleQuery(inst);
                break;
            case 'clarify':
                addChatMessage('ai', '❓ ' + (inst.message || 'Pouvez-vous préciser ?'));
                break;
            case 'answer':
                addChatMessage('ai', inst.message);
                break;
            default:
                addChatMessage('ai', '❓ Je n\'ai pas compris. Reformulez (ex: sandwich 1000F cash, supprime la dernière, modifie en wave).');
        }
    } catch (err) {
        console.error('Execute error:', err);
        addChatMessage('ai', '❌ Erreur lors de l\'exécution.');
    }
}

// ==================== ACTIONS TRANSACTIONS ====================
async function handleAddTransaction(inst) {
    // Trouver ou créer catégorie
    let catId = null;
    for (let [id, cat] of categoriesMap.entries()) {
        if (cat.name.toLowerCase() === (inst.category || '').toLowerCase()) catId = id;
    }
    if (!catId && inst.category) {
        const { data, error } = await db
            .from('categories')
            .insert({ user_id: currentUser.id, name: inst.category, icon: '📌' })
            .select();
        if (!error && data) {
            catId = data[0].id;
            categoriesMap.set(catId, data[0]);
        }
    }
    // Trouver compte
    let accId = null;
    for (let [id, acc] of accountsMap.entries()) {
        if (acc.name === inst.account) accId = id;
    }
    if (!accId) {
        addChatMessage('ai', '❌ Compte non trouvé. Comptes disponibles: ' + Array.from(accountsMap.values()).map(a => a.name).join(', '));
        return;
    }

    const { data, error } = await db.from('transactions').insert({
        user_id: currentUser.id,
        amount: inst.amount,
        description: inst.description,
        category_id: catId,
        account_id: accId,
        type: inst.action === 'add_income' ? 'income' : 'expense',
        date: inst.date || new Date().toISOString().split('T')[0]
    }).select();

    if (!error && data) {
        lastCreatedTransactionId = data[0].id;
        const account = accountsMap.get(accId);
        const delta = inst.action === 'add_income' ? inst.amount : -inst.amount;
        const newBalance = account.balance + delta;
        await db.from('accounts').update({ balance: newBalance }).eq('id', accId);
        account.balance = newBalance;
        updateBalancesDisplay();
        const typeLabel = inst.action === 'add_income' ? 'Revenu' : 'Dépense';
        addChatMessage('ai', `✅ ${typeLabel} ajouté : ${inst.amount} F (${inst.category || 'Sans catégorie'}) sur ${inst.account}`);
        await refreshDashboard();
    } else {
        addChatMessage('ai', '❌ Erreur ajout transaction');
    }
}

async function handleAddToSavings(inst) {
    const sourceName = inst.source || 'cash';
    let sourceId = null, epargneId = null;
    for (let [id, acc] of accountsMap.entries()) {
        if (acc.name === sourceName) sourceId = id;
        if (acc.name === 'epargne') epargneId = id;
    }
    if (!sourceId || !epargneId) {
        addChatMessage('ai', '❌ Compte source ou épargne introuvable');
        return;
    }
    const sourceAcc = accountsMap.get(sourceId);
    const epargneAcc = accountsMap.get(epargneId);
    if (sourceAcc.balance < inst.amount) {
        addChatMessage('ai', `❌ Solde ${sourceName} insuffisant (${sourceAcc.balance} F)`);
        return;
    }

    await db.from('accounts').update({ balance: sourceAcc.balance - inst.amount }).eq('id', sourceId);
    await db.from('accounts').update({ balance: epargneAcc.balance + inst.amount }).eq('id', epargneId);
    sourceAcc.balance -= inst.amount;
    epargneAcc.balance += inst.amount;
    updateBalancesDisplay();
    addChatMessage('ai', `💰 ${inst.amount} F transférés de ${sourceName} vers épargne`);
    await refreshDashboard();
}

async function handleDeleteTransaction(inst) {
    let transId = inst.transaction_id;
    // Si pas d'ID précis, utiliser la dernière transaction créée
    if (!transId && lastCreatedTransactionId) transId = lastCreatedTransactionId;
    if (!transId) {
        addChatMessage('ai', '❌ Aucune transaction à supprimer. Précisez l\'ID ou faites une transaction d\'abord.');
        return;
    }

    const { data: trans, error: fetchErr } = await db
        .from('transactions')
        .select('*, accounts(id, name, balance)')
        .eq('id', transId)
        .eq('user_id', currentUser.id)
        .single();
    if (fetchErr || !trans) {
        addChatMessage('ai', '❌ Transaction introuvable.');
        return;
    }

    // Restaurer le solde
    const acc = accountsMap.get(trans.account_id);
    if (acc) {
        const delta = trans.type === 'income' ? -trans.amount : trans.amount;
        const newBalance = acc.balance + delta;
        await db.from('accounts').update({ balance: newBalance }).eq('id', trans.account_id);
        acc.balance = newBalance;
        updateBalancesDisplay();
    }

    const { error } = await db.from('transactions').delete().eq('id', transId).eq('user_id', currentUser.id);
    if (!error) {
        addChatMessage('ai', `🗑️ Transaction supprimée (${trans.amount} F - ${trans.description || 'sans description'})`);
        if (lastCreatedTransactionId === transId) lastCreatedTransactionId = null;
        await refreshDashboard();
    } else {
        addChatMessage('ai', '❌ Erreur suppression transaction.');
    }
}

async function handleUpdateTransaction(inst) {
    let transId = inst.transaction_id;
    if (!transId && lastCreatedTransactionId) transId = lastCreatedTransactionId;
    if (!transId) {
        addChatMessage('ai', '❌ Aucune transaction à modifier. Précisez l\'ID.');
        return;
    }

    const { data: trans, error: fetchErr } = await db
        .from('transactions')
        .select('*, accounts(id, name, balance)')
        .eq('id', transId)
        .eq('user_id', currentUser.id)
        .single();
    if (fetchErr || !trans) {
        addChatMessage('ai', '❌ Transaction introuvable.');
        return;
    }

    // Restaurer l'ancien solde
    const oldAcc = accountsMap.get(trans.account_id);
    if (oldAcc) {
        const oldDelta = trans.type === 'income' ? -trans.amount : trans.amount;
        await db.from('accounts').update({ balance: oldAcc.balance + oldDelta }).eq('id', trans.account_id);
        oldAcc.balance += oldDelta;
    }

    // Préparer les mises à jour
    const updates = {};
    const fields = inst.fields_to_update || {};
    if (fields.amount !== undefined) updates.amount = fields.amount;
    if (fields.description !== undefined) updates.description = fields.description;
    if (fields.date !== undefined) updates.date = fields.date;
    if (fields.type !== undefined) updates.type = fields.type;

    // Nouveau compte
    let newAccId = trans.account_id;
    if (fields.account) {
        for (let [id, acc] of accountsMap.entries()) {
            if (acc.name === fields.account) newAccId = id;
        }
        updates.account_id = newAccId;
    }

    // Nouvelle catégorie
    if (fields.category) {
        let catId = null;
        for (let [id, cat] of categoriesMap.entries()) {
            if (cat.name.toLowerCase() === fields.category.toLowerCase()) catId = id;
        }
        if (!catId) {
            const { data } = await db.from('categories')
                .insert({ user_id: currentUser.id, name: fields.category, icon: '📌' }).select();
            if (data) { catId = data[0].id; categoriesMap.set(catId, data[0]); }
        }
        updates.category_id = catId;
    }

    const { error } = await db.from('transactions').update(updates).eq('id', transId);
    if (!error) {
        // Appliquer le nouveau solde
        const newAcc = accountsMap.get(newAccId);
        const newAmount = updates.amount !== undefined ? updates.amount : trans.amount;
        const newType = updates.type || trans.type;
        if (newAcc) {
            const newDelta = newType === 'income' ? newAmount : -newAmount;
            await db.from('accounts').update({ balance: newAcc.balance + newDelta }).eq('id', newAccId);
            newAcc.balance += newDelta;
        }
        updateBalancesDisplay();
        addChatMessage('ai', `✏️ Transaction modifiée avec succès.`);
        await refreshDashboard();
    } else {
        addChatMessage('ai', '❌ Erreur modification transaction.');
    }
}

// ==================== ACTIONS COMPTES ====================
async function handleAddAccount(inst) {
    const name = (inst.new_name || inst.account || '').toLowerCase().replace(/\s+/g, '_');
    if (!name) {
        addChatMessage('ai', '❌ Nom de compte invalide.');
        return;
    }
    const { data: existing } = await db.from('accounts')
        .select('*').eq('user_id', currentUser.id).eq('name', name).single();
    if (existing) {
        addChatMessage('ai', `❌ Le compte "${name}" existe déjà.`);
        return;
    }
    const { data, error } = await db.from('accounts')
        .insert({ user_id: currentUser.id, name, balance: inst.balance || 0 }).select();
    if (!error && data) {
        accountsMap.set(data[0].id, data[0]);
        updateBalancesDisplay();
        addChatMessage('ai', `🏦 Compte "${name}" créé avec ${inst.balance || 0} F.`);
    } else {
        addChatMessage('ai', '❌ Erreur création compte.');
    }
}

async function handleUpdateAccount(inst) {
    const oldName = inst.old_name;
    const newName = (inst.new_name || '').toLowerCase().replace(/\s+/g, '_');
    if (!oldName || !newName) {
        addChatMessage('ai', '❌ Noms de compte invalides.');
        return;
    }
    let accId = null;
    for (let [id, acc] of accountsMap.entries()) {
        if (acc.name === oldName) accId = id;
    }
    if (!accId) {
        addChatMessage('ai', `❌ Compte "${oldName}" introuvable.`);
        return;
    }
    const updates = { name: newName };
    if (inst.balance !== undefined) updates.balance = inst.balance;
    const { error } = await db.from('accounts').update(updates).eq('id', accId);
    if (!error) {
        const acc = accountsMap.get(accId);
        acc.name = newName;
        if (inst.balance !== undefined) acc.balance = inst.balance;
        updateBalancesDisplay();
        addChatMessage('ai', `🏦 Compte renommé: "${oldName}" → "${newName}".`);
    } else {
        addChatMessage('ai', '❌ Erreur modification compte.');
    }
}

// ==================== REQUÊTES ====================
async function handleQuery(inst) {
    if (inst.type === 'total') {
        const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
        addChatMessage('ai', inst.message || `📊 Total dépenses période: ${total} F`);
    } else if (inst.type === 'forecast') {
        const today = new Date();
        const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const daysPassed = today.getDate();
        const totalSpent = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
        const avgPerDay = totalSpent / (daysPassed || 1);
        const forecast = avgPerDay * (daysInMonth - daysPassed);
        addChatMessage('ai', `📈 Prévision fin de mois: ~${Math.round(forecast)} F supplémentaires si vous gardez ce rythme.`);
    } else if (inst.type === 'best_days') {
        const dayMap = new Map();
        transactionsData.forEach(t => {
            if (t.type === 'expense') {
                const day = new Date(t.date).getDay();
                dayMap.set(day, (dayMap.get(day) || 0) + t.amount);
            }
        });
        let bestDay = null, bestValue = Infinity;
        for (let [d, val] of dayMap) {
            if (val < bestValue) { bestValue = val; bestDay = d; }
        }
        const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        if (bestDay !== null) {
            addChatMessage('ai', `🔥 Meilleur jour (moins de dépenses): ${days[bestDay]} avec ${bestValue} F.`);
        } else {
            addChatMessage('ai', "Pas assez de données pour analyser les jours.");
        }
    } else {
        addChatMessage('ai', inst.message || 'Analyse effectuée.');
    }
}

async function generateInsights() {
    const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
    const nbJours = Math.max(1, Math.ceil(
        (new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)
    ));
    const moyenne = total / nbJours;
    document.getElementById('insightsContent').innerHTML = `
        <p>📉 Dépense quotidienne moyenne: <strong>${moyenne.toFixed(0)} F</strong></p>
        <p>💡 ${moyenne > 5000 ? 'Attention, vos dépenses sont élevées.' : 'Bonne maîtrise du budget !'}</p>
    `;
}

function addChatMessage(sender, text) {
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'user-msg' : sender === 'system' ? 'system-msg' : 'ai-msg';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==================== MODALS MANUELS ====================
function openTransactionModal(mode = 'add', transactionId = null) {
    const modal = document.getElementById('transactionModal');
    const title = document.getElementById('transactionModalTitle');
    const form = document.getElementById('transactionForm');

    title.textContent = mode === 'edit' ? '✏️ Modifier transaction' : '➕ Ajouter transaction';
    form.dataset.mode = mode;
    form.dataset.transactionId = transactionId || '';

    // Remplir les selects
    const catSelect = document.getElementById('transCategory');
    const accSelect = document.getElementById('transAccount');
    catSelect.innerHTML = '<option value="">-- Choisir --</option>' + 
        Array.from(categoriesMap.values()).map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
    accSelect.innerHTML = '<option value="">-- Choisir --</option>' + 
        Array.from(accountsMap.values()).map(a => `<option value="${a.id}">${getAccountEmoji(a.name)} ${a.name}</option>`).join('');

    if (mode === 'edit' && transactionId) {
        const t = transactionsData.find(tx => tx.id === transactionId);
        if (t) {
            document.getElementById('transAmount').value = t.amount;
            document.getElementById('transDescription').value = t.description || '';
            document.getElementById('transType').value = t.type;
            document.getElementById('transDate').value = t.date;
            catSelect.value = t.category_id || '';
            accSelect.value = t.account_id || '';
        }
    } else {
        form.reset();
        document.getElementById('transDate').value = new Date().toISOString().split('T')[0];
    }

    modal.style.display = 'flex';
}

async function saveTransactionForm() {
    const form = document.getElementById('transactionForm');
    const mode = form.dataset.mode;
    const transId = form.dataset.transactionId;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const description = document.getElementById('transDescription').value;
    const type = document.getElementById('transType').value;
    const date = document.getElementById('transDate').value;
    const categoryId = document.getElementById('transCategory').value;
    const accountId = document.getElementById('transAccount').value;

    if (!amount || !accountId) {
        alert('Montant et compte obligatoires');
        return;
    }

    if (mode === 'edit' && transId) {
        await executeInstruction({
            action: 'update_transaction',
            transaction_id: transId,
            fields_to_update: { amount, description, type, date, account: accountsMap.get(accountId)?.name }
        });
    } else {
        const cat = categoriesMap.get(categoryId);
        await executeInstruction({
            action: type === 'income' ? 'add_income' : 'add_expense',
            amount, description,
            category: cat?.name || 'Autres',
            account: accountsMap.get(accountId)?.name,
            date
        });
    }
    closeModal('transactionModal');
}

async function editTransaction(id) {
    openTransactionModal('edit', id);
}

async function deleteTransaction(id) {
    if (!confirm('Supprimer cette transaction ?')) return;
    await executeInstruction({ action: 'delete_transaction', transaction_id: id });
}

function openAccountsModal() {
    const modal = document.getElementById('accountsModal');
    const listDiv = document.getElementById('accountsList');
    listDiv.innerHTML = '';
    for (let acc of accountsMap.values()) {
        const item = document.createElement('div');
        item.className = 'account-item';
        item.innerHTML = `
            <span>${getAccountEmoji(acc.name)} ${acc.name}: ${acc.balance} F</span>
            <div>
                <button class="btn-icon" onclick="editAccount('${acc.id}')">✏️</button>
                <button class="btn-icon" onclick="deleteAccount('${acc.id}')">🗑️</button>
            </div>
        `;
        listDiv.appendChild(item);
    }
    modal.style.display = 'flex';
}

async function addAccountManual() {
    const name = document.getElementById('newAccountName').value.trim().toLowerCase().replace(/\s+/g, '_');
    const balance = parseFloat(document.getElementById('newAccountBalance').value) || 0;
    if (!name) return;
    await executeInstruction({ action: 'add_account', new_name: name, balance });
    document.getElementById('newAccountName').value = '';
    document.getElementById('newAccountBalance').value = '';
    openAccountsModal();
}

async function editAccount(id) {
    const acc = accountsMap.get(id);
    if (!acc) return;
    const newName = prompt('Nouveau nom:', acc.name);
    if (newName && newName !== acc.name) {
        await executeInstruction({ action: 'update_account', old_name: acc.name, new_name: newName });
        openAccountsModal();
    }
}

async function deleteAccount(id) {
    const acc = accountsMap.get(id);
    if (!acc) return;
    if (!confirm(`Supprimer le compte "${acc.name}" ? Les transactions associées seront orphelines.`)) return;
    const { error } = await db.from('accounts').delete().eq('id', id).eq('user_id', currentUser.id);
    if (!error) {
        accountsMap.delete(id);
        updateBalancesDisplay();
        openAccountsModal();
        await refreshDashboard();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

// ==================== GESTION CATÉGORIES ====================
async function showCategoriesModal() {
    const modal = document.getElementById('categoriesModal');
    const listDiv = document.getElementById('categoriesList');
    listDiv.innerHTML = '';
    for (let cat of categoriesMap.values()) {
        const item = document.createElement('div');
        item.innerHTML = `<span>${cat.icon} ${cat.name}</span>`;
        const btn = document.createElement('button');
        btn.textContent = '🗑️';
        btn.onclick = () => deleteCategory(cat.id);
        item.appendChild(btn);
        listDiv.appendChild(item);
    }
    modal.style.display = 'flex';
}

async function deleteCategory(id) {
    await db.from('categories').delete().eq('id', id);
    await loadUserData();
    showCategoriesModal();
}

async function addCategory() {
    const name = document.getElementById('newCategoryName').value.trim();
    const icon = document.getElementById('newCategoryIcon').value || '📌';
    if (!name) return;
    await db.from('categories').insert({ user_id: currentUser.id, name, icon });
    await loadUserData();
    showCategoriesModal();
    document.getElementById('newCategoryName').value = '';
    document.getElementById('newCategoryIcon').value = '';
}

// ==================== EVENT LISTENERS ====================
document.getElementById('loginBtn').onclick = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('applyCustomBtn').onclick = setPeriodeCustom;
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => loadPeriod(btn.dataset.period);
});
document.getElementById('manageCategoriesBtn').onclick = showCategoriesModal;
document.getElementById('addCategoryBtn').onclick = addCategory;
document.querySelector('.close')?.onclick = () => closeModal('categoriesModal');

// Nouveaux boutons
document.getElementById('addTransactionBtn')?.onclick = () => openTransactionModal('add');
document.getElementById('manageAccountsBtn')?.onclick = openAccountsModal;
document.getElementById('saveTransactionBtn')?.onclick = saveTransactionForm;
document.getElementById('addAccountBtn')?.onclick = addAccountManual;

// Fermeture modals par clic extérieur
window.onclick = (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.display = 'none';
    }
};

userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
});

checkAuth();
