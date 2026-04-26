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
let lastCreatedTransactionId = null;

// État du tableau
let currentPage = 1;
const rowsPerPage = 10;
let filterType = 'all';
let sortColumn = 'date';
let sortOrder = 'desc';

// Historique local de la conversation (envoyé au backend)
let conversationMessages = [];

// DOM
const authScreen = document.getElementById('authScreen');
const dashboard = document.getElementById('dashboardScreen');
const userEmailSpan = document.getElementById('userEmail');
const balancesDiv = document.getElementById('balances');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const statsContainer = document.getElementById('statsContainer');
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
    else alert('Inscription réussie ! Connectez-vous.');
}
async function logout() { await db.auth.signOut(); window.location.reload(); }
async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        authScreen.style.display = 'none';
        dashboard.style.display = 'block';
        userEmailSpan.textContent = currentUser.email;
        await loadUserData();
        await loadPeriod('month');
        resetConversation(); // initialise l'historique local
        addChatMessage('system', '🟢 Connecté ! Parlez naturellement.', true);
    } else {
        authScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// ==================== CONVERSATION ====================
function addChatMessage(sender, text, isSystem = false) {
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'user-msg' : (sender === 'ai' ? 'ai-msg' : 'system-msg');
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    if (!isSystem && (sender === 'user' || sender === 'ai')) {
        const role = sender === 'user' ? 'user' : 'assistant';
        conversationMessages.push({ role, content: text });
    }
}

function resetConversation() {
    conversationMessages = [];
    chatMessages.innerHTML = '';
    addChatMessage('system', '🔄 Nouvelle conversation. Prêt à vous aider.', true);
}

// ==================== DONNÉES ====================
async function loadUserData() {
    const { data: accounts } = await db.from('accounts').select('*').eq('user_id', currentUser.id);
    if (accounts) { accountsMap.clear(); accounts.forEach(a => accountsMap.set(a.id, a)); updateBalancesDisplay(); }
    const { data: cats } = await db.from('categories').select('*').eq('user_id', currentUser.id);
    if (cats) { categoriesMap.clear(); cats.forEach(c => categoriesMap.set(c.id, c)); }
}
function updateBalancesDisplay() {
    balancesDiv.innerHTML = Array.from(accountsMap.values()).map(a => `<span>${getEmoji(a.name)} ${a.name}: ${a.balance} F</span>`).join('');
}
function getEmoji(name) { return {cash:'💵', wave:'📱', epargne:'💰'}[name] || '🏦'; }

// ==================== PÉRIODE ====================
function getDateRange(period) {
    const now = new Date();
    if (period === 'week') {
        const s = new Date(now); s.setDate(now.getDate() - now.getDay());
        return { debut: s.toISOString().slice(0,10), fin: now.toISOString().slice(0,10) };
    } else if (period === 'month') {
        return {
            debut: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10),
            fin: new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10)
        };
    } else {
        return {
            debut: new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10),
            fin: new Date(now.getFullYear(), 11, 31).toISOString().slice(0,10)
        };
    }
}
async function loadPeriod(period) {
    currentPeriode = getDateRange(period);
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.filter-btn[data-period="${period}"]`)?.classList.add('active');
    await refreshDashboard();
}
async function setPeriodeCustom() {
    const debut = document.getElementById('dateDebut').value;
    const fin = document.getElementById('dateFin').value;
    if (debut && fin) { currentPeriode = { debut, fin }; await refreshDashboard(); }
}
async function refreshDashboard() {
    await loadTransactions();
    await loadUserData();
    updateStats();
    updateChart();
    updateTransactionsTable();
    await generateInsights();
}
async function loadTransactions() {
    const { data } = await db.from('transactions')
        .select('*, categories(name,icon), accounts(name)')
        .eq('user_id', currentUser.id)
        .gte('date', currentPeriode.debut)
        .lte('date', currentPeriode.fin)
        .order('date', { ascending: false });
    transactionsData = data || [];
}

// ==================== STATS & CHART ====================
function updateStats() {
    let total = 0, income = 0;
    transactionsData.forEach(t => { if (t.type==='expense') total+=t.amount; if (t.type==='income') income+=t.amount; });
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin)-new Date(currentPeriode.debut))/(1000*3600*24)));
    statsContainer.innerHTML = `
        <div class="stat-card"><h3>💸 Dépenses</h3><div class="stat-number">${total.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📈 Revenus</h3><div class="stat-number">${income.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📊 Moy/jour</h3><div class="stat-number">${(total/nbJ).toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📅 Transactions</h3><div class="stat-number">${transactionsData.length}</div></div>
    `;
}
function updateChart() {
    const ctx = document.getElementById('expensesChart').getContext('2d');
    const totals = new Map();
    transactionsData.forEach(t => { if (t.type==='expense') { const n=t.categories?.name||'Autres'; totals.set(n,(totals.get(n)||0)+t.amount); } });
    if (expensesChart) expensesChart.destroy();
    if (!totals.size) return;
    expensesChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: [...totals.keys()], datasets: [{ data: [...totals.values()], backgroundColor: ['#3b82f6','#f97316','#10b981','#ef4444','#8b5cf6'] }] }
    });
}
async function generateInsights() {
    const total = transactionsData.reduce((s,t)=>t.type==='expense'?s+t.amount:s,0);
    const nbJ = Math.max(1,Math.ceil((new Date(currentPeriode.fin)-new Date(currentPeriode.debut))/(1000*3600*24)));
    const moy = total/nbJ;
    document.getElementById('insightsContent').innerHTML = `
        <p>📉 Moy/jour : <strong>${moy.toFixed(0)} F</strong></p>
        <p>💡 ${moy>5000 ? 'Dépenses élevées' : 'Bon contrôle'}</p>`;
}

// ==================== CHAT IA ====================
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;
    addChatMessage('user', message);
    userInput.value = '';

    const loadId = Date.now();
    addChatMessage('ai', '⏳ ...', false);
    const aiMsgDiv = chatMessages.lastChild;

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                userId: currentUser.id,
                periode: currentPeriode,
                history: conversationMessages.slice(0, -1) // tout sauf le dernier message déjà ajouté
            })
        });
        const result = await res.json();
        aiMsgDiv.textContent = result.message || 'Action exécutée.';
        
        // Exécuter l'action retournée (add_expense, etc.)
        if (result.action) {
            await executeInstruction(result);
            await refreshDashboard();
        } else {
            // Juste une réponse texte, on l'a déjà affichée
        }
        // La réponse a été ajoutée dans addChatMessage lors de l'affichage, mais attention : on l'a déjà mise dans le DOM.
        // Pour éviter doublon dans conversationMessages, on ajuste :
        // On supprime le dernier message IA vide et on ajoute proprement
        conversationMessages.pop(); // enlever le message "⏳"
        addChatMessage('ai', aiMsgDiv.textContent, false);
    } catch (err) {
        aiMsgDiv.textContent = '❌ Erreur de connexion.';
        console.error(err);
    }
}

async function executeInstruction(inst) {
    try {
        switch(inst.action) {
            case 'add_expense': case 'add_income': await handleAddTransaction(inst); break;
            case 'add_to_savings': await handleAddToSavings(inst); break;
            case 'delete_transaction': await handleDeleteTransaction(inst); break;
            case 'update_transaction': await handleUpdateTransaction(inst); break;
            case 'add_account': await handleAddAccount(inst); break;
            case 'update_account': await handleUpdateAccount(inst); break;
            case 'fetch_balance':
                let total = 0;
                for (let acc of accountsMap.values()) total += acc.balance;
                addChatMessage('ai', `💰 Solde total : ${total} F`, false);
                break;
            case 'query':
                if (inst.type === 'total') {
                    const tot = transactionsData.reduce((s,t)=>t.type==='expense'?s+t.amount:s,0);
                    addChatMessage('ai', `📊 Total dépenses : ${tot} F`, false);
                } else if (inst.type === 'forecast') {
                    // calcul simple
                    const today = new Date();
                    const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
                    const daysPassed = today.getDate();
                    const spent = transactionsData.reduce((s,t)=>t.type==='expense'?s+t.amount:s,0);
                    const avg = spent / (daysPassed||1);
                    const forecast = avg * (daysInMonth - daysPassed);
                    addChatMessage('ai', `📈 Prévision fin de mois : ~${Math.round(forecast)} F`, false);
                } else if (inst.type === 'best_days') {
                    const dayMap = new Map();
                    transactionsData.forEach(t => { if(t.type==='expense') { const d = new Date(t.date).getDay(); dayMap.set(d, (dayMap.get(d)||0)+t.amount); } });
                    let best = null, min = Infinity;
                    for (let [d,v] of dayMap) if(v<min) { min=v; best=d; }
                    const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
                    addChatMessage('ai', best!==null ? `🔥 Moins de dépenses le ${days[best]} (${min}F)` : "Pas assez de données", false);
                } else {
                    addChatMessage('ai', inst.message || 'Analyse effectuée.', false);
                }
                break;
            case 'clarify':
                addChatMessage('ai', inst.message || 'Précisez.', false);
                break;
            case 'answer':
                addChatMessage('ai', inst.message || '', false);
                break;
            default:
                addChatMessage('ai', "Je n'ai pas compris.", false);
        }
    } catch(e) { console.error(e); addChatMessage('ai','❌ Erreur exécution.', false); }
}

// ==================== TRANSACTIONS ====================
async function handleAddTransaction(inst) {
    let catId = null;
    for (let [id,cat] of categoriesMap) if (cat.name.toLowerCase() === (inst.category||'').toLowerCase()) { catId=id; break; }
    if (!catId && inst.category) {
        const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: inst.category, icon: '📌' }).select();
        if (data?.[0]) { catId = data[0].id; categoriesMap.set(catId, data[0]); }
    }
    let accId = null;
    for (let [id,acc] of accountsMap) if (acc.name === inst.account) { accId=id; break; }
    if (!accId) { addChatMessage('ai', `❌ Compte "${inst.account}" introuvable.`, false); return; }

    const isIncome = inst.action === 'add_income';
    const { data, error } = await db.from('transactions').insert({
        user_id: currentUser.id,
        amount: inst.amount,
        description: inst.description || '',
        category_id: catId,
        account_id: accId,
        type: isIncome ? 'income' : 'expense',
        date: inst.date || new Date().toISOString().slice(0,10)
    }).select();
    if (!error && data?.[0]) {
        lastCreatedTransactionId = data[0].id;
        const acc = accountsMap.get(accId);
        const newBalance = isIncome ? acc.balance + inst.amount : acc.balance - inst.amount;
        await db.from('accounts').update({ balance: newBalance }).eq('id', accId);
        acc.balance = newBalance;
        updateBalancesDisplay();
        addChatMessage('ai', `${isIncome ? '💰 Revenu' : '💸 Dépense'} ajouté : ${inst.amount} F (${inst.category||'Autres'}) sur ${inst.account}`, false);
    } else { addChatMessage('ai', '❌ Erreur ajout.', false); }
}

async function handleAddToSavings(inst) {
    const src = inst.source || 'cash';
    let srcId=null, epId=null;
    for (let [id,a] of accountsMap) { if(a.name===src) srcId=id; if(a.name==='epargne') epId=id; }
    if (!srcId || !epId) { addChatMessage('ai', '❌ Compte introuvable.', false); return; }
    const srcAcc = accountsMap.get(srcId);
    const epAcc = accountsMap.get(epId);
    if (srcAcc.balance < inst.amount) { addChatMessage('ai', `❌ Solde ${src} insuffisant`, false); return; }
    await db.from('accounts').update({ balance: srcAcc.balance - inst.amount }).eq('id', srcId);
    await db.from('accounts').update({ balance: epAcc.balance + inst.amount }).eq('id', epId);
    srcAcc.balance -= inst.amount;
    epAcc.balance += inst.amount;
    updateBalancesDisplay();
    addChatMessage('ai', `💰 ${inst.amount}F transférés de ${src} vers épargne`, false);
}

async function handleDeleteTransaction(inst) {
    const transId = inst.transaction_id || lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai', '❌ Aucune transaction à supprimer.', false); return; }
    const { data:t } = await db.from('transactions').select('*').eq('id', transId).eq('user_id', currentUser.id).single();
    if (!t) { addChatMessage('ai', '❌ Transaction introuvable.', false); return; }
    const acc = accountsMap.get(t.account_id);
    if (acc) {
        const newBal = t.type === 'income' ? acc.balance - t.amount : acc.balance + t.amount;
        await db.from('accounts').update({ balance: newBal }).eq('id', t.account_id);
        acc.balance = newBal;
        updateBalancesDisplay();
    }
    await db.from('transactions').delete().eq('id', transId).eq('user_id', currentUser.id);
    addChatMessage('ai', `🗑️ Transaction supprimée (${t.amount}F)`, false);
}

async function handleUpdateTransaction(inst) {
    const transId = inst.transaction_id || lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai', '❌ Aucune transaction à modifier.', false); return; }
    const { data:t } = await db.from('transactions').select('*').eq('id', transId).eq('user_id', currentUser.id).single();
    if (!t) { addChatMessage('ai', '❌ Transaction introuvable.', false); return; }
    // Rétablir l'ancien solde
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
        for (let [id,a] of accountsMap) if (a.name === fields.account) { newAccId = id; break; }
        updates.account_id = newAccId;
    }
    if (fields.category) {
        let catId = null;
        for (let [id,c] of categoriesMap) if (c.name.toLowerCase() === fields.category.toLowerCase()) { catId = id; break; }
        if (!catId) {
            const { data } = await db.from('categories').insert({ user_id: currentUser.id, name: fields.category, icon: '📌' }).select();
            if (data?.[0]) { catId = data[0].id; categoriesMap.set(catId, data[0]); }
        }
        if (catId) updates.category_id = catId;
    }
    await db.from('transactions').update(updates).eq('id', transId);
    // Appliquer nouveau solde
    const newAcc = accountsMap.get(newAccId);
    const newAmount = updates.amount !== undefined ? updates.amount : t.amount;
    const newType = t.type; // le type ne change pas dans cette version simplifiée
    if (newAcc) {
        const delta = newType === 'income' ? newAmount : -newAmount;
        await db.from('accounts').update({ balance: newAcc.balance + delta }).eq('id', newAccId);
        newAcc.balance += delta;
    }
    updateBalancesDisplay();
    addChatMessage('ai', '✏️ Transaction modifiée.', false);
}

async function handleAddAccount(inst) {
    const name = (inst.new_name || '').toLowerCase().replace(/\s+/g,'_');
    if(!name) return;
    const { data, error } = await db.from('accounts').insert({ user_id: currentUser.id, name, balance: inst.balance || 0 }).select();
    if (!error && data?.[0]) { accountsMap.set(data[0].id, data[0]); updateBalancesDisplay(); addChatMessage('ai', `🏦 Compte "${name}" créé.`, false); }
}
async function handleUpdateAccount(inst) {
    let accId = null;
    for (let [id,a] of accountsMap) if (a.name === inst.old_name) { accId = id; break; }
    if (!accId) return;
    const newName = (inst.new_name || '').toLowerCase().replace(/\s+/g,'_');
    const upd = { name: newName };
    if (inst.balance !== undefined) upd.balance = inst.balance;
    await db.from('accounts').update(upd).eq('id', accId);
    const acc = accountsMap.get(accId);
    acc.name = newName;
    if (inst.balance !== undefined) acc.balance = inst.balance;
    updateBalancesDisplay();
    addChatMessage('ai', `🏦 Compte renommé : "${inst.old_name}" → "${newName}".`, false);
}

// ==================== TABLEAU PAGINÉ ====================
function updateTransactionsTable() {
    const tbody = document.getElementById('transactionsTableBody');
    const paginationDiv = document.getElementById('transactionsPagination');
    if (!tbody) return;
    let filtered = [...transactionsData];
    if (filterType === 'expense') filtered = filtered.filter(t => t.type === 'expense');
    else if (filterType === 'income') filtered = filtered.filter(t => t.type === 'income');
    filtered.sort((a,b) => {
        let valA, valB;
        if (sortColumn === 'date') { valA = new Date(a.date); valB = new Date(b.date); }
        else if (sortColumn === 'amount') { valA = a.amount; valB = b.amount; }
        else if (sortColumn === 'category') { valA = (a.categories?.name||'').toLowerCase(); valB = (b.categories?.name||'').toLowerCase(); }
        else return 0;
        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
    });
    const totalPages = Math.ceil(filtered.length / rowsPerPage) || 1;
    if (currentPage > totalPages) currentPage = 1;
    const start = (currentPage-1)*rowsPerPage;
    const pageRows = filtered.slice(start, start+rowsPerPage);
    tbody.innerHTML = pageRows.map(t => {
        const cat = t.categories || { name: 'Autres', icon: '📦' };
        const acc = t.accounts || { name: 'cash' };
        const sign = t.type === 'expense' ? '-' : '+';
        const cls = t.type === 'expense' ? 'expense' : 'income';
        return `<tr>
            <td>${t.date}</td>
            <td><span class="category-badge">${cat.icon} ${cat.name}</span></td>
            <td class="${cls}">${sign} ${t.amount} F</td>
            <td>${acc.name}</td>
            <td>${t.description || ''}</td>
            <td class="table-actions">
                <button class="btn-icon" onclick="editTransaction('${t.id}')">✏️</button>
                <button class="btn-icon" onclick="deleteTransaction('${t.id}')">🗑️</button>
            </td>
        </tr>`;
    }).join('');
    paginationDiv.innerHTML = `
        <div>${filtered.length} transaction(s) - Page ${currentPage}/${totalPages}</div>
        <div>
            <button class="btn-small" onclick="changePage(-1)" ${currentPage===1 ? 'disabled' : ''}>◀ Précédent</button>
            <button class="btn-small" onclick="changePage(1)" ${currentPage===totalPages ? 'disabled' : ''}>Suivant ▶</button>
        </div>
    `;
}
window.changePage = (delta) => {
    let count = transactionsData.length;
    if (filterType === 'expense') count = transactionsData.filter(t=>t.type==='expense').length;
    else if (filterType === 'income') count = transactionsData.filter(t=>t.type==='income').length;
    const total = Math.ceil(count/rowsPerPage);
    const newPage = currentPage + delta;
    if (newPage>=1 && newPage<=total) { currentPage = newPage; updateTransactionsTable(); }
};
function setFilterType(type) { filterType = type; currentPage = 1; updateTransactionsTable(); }
function setSort(col) {
    if (sortColumn === col) sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    else { sortColumn = col; sortOrder = 'asc'; }
    currentPage = 1;
    updateTransactionsTable();
}

// ==================== MODALS ====================
function openTransactionModal(mode='add', id=null) {
    const modal = document.getElementById('transactionModal');
    document.getElementById('transactionModalTitle').innerText = mode==='edit' ? '✏️ Modifier' : '➕ Ajouter';
    const form = document.getElementById('transactionForm');
    form.dataset.mode = mode;
    form.dataset.transactionId = id || '';
    const catSel = document.getElementById('transCategory');
    const accSel = document.getElementById('transAccount');
    catSel.innerHTML = '<option value="">-- Choisir --</option>' + Array.from(categoriesMap.values()).map(c=>`<option value="${c.id}">${c.icon} ${c.name}</option>`);
    accSel.innerHTML = '<option value="">-- Choisir --</option>' + Array.from(accountsMap.values()).map(a=>`<option value="${a.id}">${getEmoji(a.name)} ${a.name}</option>`);
    if (mode==='edit' && id) {
        const t = transactionsData.find(x=>x.id===id);
        if (t) {
            document.getElementById('transAmount').value = t.amount;
            document.getElementById('transDescription').value = t.description || '';
            document.getElementById('transType').value = t.type;
            document.getElementById('transDate').value = t.date;
            catSel.value = t.category_id || '';
            accSel.value = t.account_id || '';
        }
    } else {
        document.getElementById('transactionForm').reset();
        document.getElementById('transDate').value = new Date().toISOString().slice(0,10);
    }
    modal.style.display = 'flex';
}
async function saveTransactionForm() {
    const form = document.getElementById('transactionForm');
    const mode = form.dataset.mode;
    const transId = form.dataset.transactionId;
    const amount = parseFloat(document.getElementById('transAmount').value);
    const desc = document.getElementById('transDescription').value;
    const type = document.getElementById('transType').value;
    const date = document.getElementById('transDate').value;
    const accId = document.getElementById('transAccount').value;
    const catId = document.getElementById('transCategory').value;
    if (!amount || !accId) return alert('Montant et compte requis');
    if (mode === 'edit' && transId) {
        await executeInstruction({
            action: 'update_transaction',
            transaction_id: transId,
            fields_to_update: {
                amount, description: desc, type, date,
                account: accountsMap.get(accId)?.name,
                category: categoriesMap.get(catId)?.name
            }
        });
    } else {
        await executeInstruction({
            action: type === 'income' ? 'add_income' : 'add_expense',
            amount, description: desc,
            category: categoriesMap.get(catId)?.name || 'Autres',
            account: accountsMap.get(accId)?.name,
            date
        });
    }
    closeModal('transactionModal');
    await refreshDashboard();
}
window.editTransaction = (id) => openTransactionModal('edit', id);
window.deleteTransaction = async (id) => { if(confirm('Supprimer ?')) await executeInstruction({ action: 'delete_transaction', transaction_id: id }); await refreshDashboard(); };
function openAccountsModal() {
    const modal = document.getElementById('accountsModal');
    const listDiv = document.getElementById('accountsList');
    listDiv.innerHTML = '';
    for (let acc of accountsMap.values()) {
        const div = document.createElement('div');
        div.className = 'account-item';
        div.innerHTML = `<span>${getEmoji(acc.name)} ${acc.name}: ${acc.balance} F</span> <div><button class="btn-icon" onclick="editAccount('${acc.id}')">✏️</button> <button class="btn-icon" onclick="deleteAccount('${acc.id}')">🗑️</button></div>`;
        listDiv.appendChild(div);
    }
    modal.style.display = 'flex';
}
async function addAccountManual() {
    const name = document.getElementById('newAccountName').value.trim().toLowerCase().replace(/\s+/g,'_');
    const balance = parseFloat(document.getElementById('newAccountBalance').value) || 0;
    if (!name) return;
    await executeInstruction({ action: 'add_account', new_name: name, balance });
    document.getElementById('newAccountName').value = '';
    document.getElementById('newAccountBalance').value = '0';
    openAccountsModal();
}
window.editAccount = async (id) => {
    const acc = accountsMap.get(id);
    if (!acc) return;
    const newName = prompt('Nouveau nom:', acc.name);
    if (newName && newName !== acc.name) await executeInstruction({ action: 'update_account', old_name: acc.name, new_name: newName });
    openAccountsModal();
};
window.deleteAccount = async (id) => {
    const acc = accountsMap.get(id);
    if (!acc || !confirm(`Supprimer ${acc.name} ?`)) return;
    await db.from('accounts').delete().eq('id', id).eq('user_id', currentUser.id);
    accountsMap.delete(id);
    updateBalancesDisplay();
    openAccountsModal();
    await refreshDashboard();
};
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
async function showCategoriesModal() { /* similaire à accounts */ }
async function addCategory() { /* existant */ }

// ==================== EVENT LISTENERS ====================
document.getElementById('loginBtn').onclick = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('applyCustomBtn').onclick = setPeriodeCustom;
document.querySelectorAll('.filter-btn').forEach(b => b.onclick = () => loadPeriod(b.dataset.period));
document.getElementById('manageCategoriesBtn').onclick = showCategoriesModal;
document.getElementById('addCategoryBtn').onclick = addCategory;
document.getElementById('addTransactionBtn').onclick = () => openTransactionModal('add');
document.getElementById('manageAccountsBtn').onclick = openAccountsModal;
document.getElementById('addAccountBtn').onclick = addAccountManual;
document.getElementById('resetChatBtn').onclick = resetConversation;
document.querySelectorAll('.close').forEach(btn => btn.onclick = () => closeModal(btn.closest('.modal').id));
window.onclick = e => { if (e.target.classList.contains('modal')) e.target.style.display = 'none'; };
userInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
checkAuth();
