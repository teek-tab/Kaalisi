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
let abortController = null;

// État du tableau
let currentPage = 1;
const rowsPerPage = 10;
let filterType = 'all';
let sortColumn = 'date';
let sortOrder = 'desc';

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
        addChatMessage('system', "🟢 Connecté ! Parlez naturellement.");
    } else {
        authScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// ==================== DONNÉES ====================
async function loadUserData() {
    const { data: accounts } = await db.from('accounts').select('*').eq('user_id', currentUser.id);
    if (accounts) { accountsMap.clear(); accounts.forEach(a => accountsMap.set(a.id, a)); updateBalancesDisplay(); }
    const { data: cats } = await db.from('categories').select('*').eq('user_id', currentUser.id);
    if (cats) { categoriesMap.clear(); cats.forEach(c => categoriesMap.set(c.id, c)); }
}
function updateBalancesDisplay() {
    balancesDiv.innerHTML = Array.from(accountsMap.values())
        .map(a => `<span>${getAccountEmoji(a.name)} ${a.name}: ${a.balance} F</span>`).join('');
}
function getAccountEmoji(name) { return {cash:'💵',wave:'📱',epargne:'💰'}[name] || '🏦'; }

// ==================== PÉRIODE ====================
function getDateRange(period) {
    const now = new Date();
    if (period === 'week') {
        const s = new Date(now); s.setDate(now.getDate() - now.getDay());
        return { debut: s.toISOString().split('T')[0], fin: now.toISOString().split('T')[0] };
    } else if (period === 'month') {
        return {
            debut: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0],
            fin: new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().split('T')[0]
        };
    } else {
        return {
            debut: new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0],
            fin: new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0]
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

// ==================== STATS ====================
function updateStats() {
    let total = 0, income = 0;
    transactionsData.forEach(t => { if (t.type==='expense') total+=t.amount; if (t.type==='income') income+=t.amount; });
    const nbJ = Math.max(1, Math.ceil((new Date(currentPeriode.fin)-new Date(currentPeriode.debut))/(1000*3600*24)));
    statsContainer.innerHTML = `
        <div class="stat-card"><h3>💸 Dépenses</h3><div class="stat-number">${total.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📈 Revenus</h3><div class="stat-number">${income.toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📊 Moy/jour</h3><div class="stat-number">${(total/nbJ).toFixed(0)} F</div></div>
        <div class="stat-card"><h3>📅 Transactions</h3><div class="stat-number">${transactionsData.length}</div></div>`;
}
function updateChart() {
    const ctx = document.getElementById('expensesChart').getContext('2d');
    const totals = new Map();
    transactionsData.forEach(t => { if (t.type==='expense') { const n=t.categories?.name||'Autres'; totals.set(n,(totals.get(n)||0)+t.amount); } });
    if (expensesChart) expensesChart.destroy();
    if (!totals.size) return;
    expensesChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: [...totals.keys()], datasets: [{ data: [...totals.values()], backgroundColor: ['#3b82f6','#f97316','#10b981','#ef4444','#8b5cf6','#f59e0b','#06b6d4','#ec4899'] }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}
async function generateInsights() {
    const total = transactionsData.reduce((s,t)=>t.type==='expense'?s+t.amount:s,0);
    const nbJ = Math.max(1,Math.ceil((new Date(currentPeriode.fin)-new Date(currentPeriode.debut))/(1000*3600*24)));
    const moy = total/nbJ;
    document.getElementById('insightsContent').innerHTML = `
        <p>📉 Moy/jour : <strong>${moy.toFixed(0)} F</strong></p>
        <p>💡 ${moy>5000?'Dépenses élevées !':'Bon contrôle du budget !'}</p>`;
}

// ==================== TABLEAU ====================
function updateTransactionsTable() {
    const tbody = document.getElementById('transactionsTableBody');
    const paginationDiv = document.getElementById('transactionsPagination');
    if (!tbody || !paginationDiv) return;

    let filtered = [...transactionsData];
    if (filterType === 'expense') filtered = filtered.filter(t => t.type === 'expense');
    else if (filterType === 'income') filtered = filtered.filter(t => t.type === 'income');

    filtered.sort((a,b) => {
        let valA, valB;
        if (sortColumn === 'date') {
            valA = new Date(a.date); valB = new Date(b.date);
        } else if (sortColumn === 'amount') {
            valA = a.amount; valB = b.amount;
        } else if (sortColumn === 'category') {
            valA = (a.categories?.name || '').toLowerCase();
            valB = (b.categories?.name || '').toLowerCase();
        } else { return 0; }
        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    const totalPages = Math.ceil(filtered.length / rowsPerPage) || 1;
    if (currentPage > totalPages) currentPage = 1;
    const start = (currentPage-1)*rowsPerPage;
    const pageRows = filtered.slice(start, start+rowsPerPage);

    if (pageRows.length === 0) {
        tbody.innerHTML = '<td><td colspan="6" class="empty-table">Aucune transaction</td></tr>';
    } else {
        tbody.innerHTML = pageRows.map(t => {
            const cat = t.categories || { name: 'Autres', icon: '📦' };
            const acc = t.accounts || { name: 'cash' };
            const amountClass = t.type === 'expense' ? 'expense' : 'income';
            const amountSign = t.type === 'expense' ? '-' : '+';
            return `
                <tr>
                    <td>${t.date}</td>
                    <td><span class="category-badge">${cat.icon} ${cat.name}</span></td>
                    <td class="${amountClass}">${amountSign} ${t.amount.toFixed(0)} F</td>
                    <td>${acc.name}</td>
                    <td title="${t.description || ''}">${(t.description || '').substring(0,30)}${(t.description?.length||0)>30?'…':''}</td>
                    <td class="table-actions">
                        <button class="btn-icon" onclick="editTransaction('${t.id}')">✏️</button>
                        <button class="btn-icon" onclick="deleteTransaction('${t.id}')">🗑️</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    paginationDiv.innerHTML = `
        <div class="pagination-info">${filtered.length} transaction(s) — Page ${currentPage} / ${totalPages}</div>
        <div class="pagination-buttons">
            <button class="btn-small" onclick="changePage(-1)" ${currentPage===1 ? 'disabled' : ''}>◀ Précédent</button>
            <button class="btn-small" onclick="changePage(1)" ${currentPage===totalPages ? 'disabled' : ''}>Suivant ▶</button>
        </div>
    `;
}

window.changePage = function(delta) {
    let filteredCount = transactionsData.length;
    if (filterType === 'expense') filteredCount = transactionsData.filter(t => t.type === 'expense').length;
    else if (filterType === 'income') filteredCount = transactionsData.filter(t => t.type === 'income').length;
    const totalPages = Math.ceil(filteredCount / rowsPerPage) || 1;
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        updateTransactionsTable();
    }
};

function setFilterType(type) {
    filterType = type;
    currentPage = 1;
    updateTransactionsTable();
    document.querySelectorAll('.filter-transaction-btn').forEach(btn => {
        if (btn.dataset.type === type) btn.classList.add('active');
        else btn.classList.remove('active');
    });
}

function setSort(column) {
    if (sortColumn === column) {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortOrder = 'asc';
    }
    currentPage = 1;
    updateTransactionsTable();
    document.querySelectorAll('.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === sortColumn) th.classList.add(sortOrder === 'asc' ? 'sort-asc' : 'sort-desc');
    });
}

// ==================== CHAT ====================
let msgCounter = 0;
let waitingForResponse = false;

function addChatMessage(sender, text, isSystem = false) {
    const id = ++msgCounter;
    const div = document.createElement('div');
    div.id = 'msg-'+id;
    div.className = sender==='user'?'user-msg':(sender==='system'||isSystem)?'system-msg':'ai-msg';
    div.style.whiteSpace = 'pre-line';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return id;
}
function removeMessage(id) { document.getElementById('msg-'+id)?.remove(); }

async function sendMessage() {
    if (waitingForResponse) {
        if (abortController) {
            abortController.abort();
            addChatMessage('system', '⏹️ Annulé.', true);
            waitingForResponse = false;
        }
        return;
    }
    const message = userInput.value.trim();
    if (!message) return;
    addChatMessage('user', message);
    userInput.value = '';
    waitingForResponse = true;
    const loadId = addChatMessage('ai', '⏳ Kaalisi réfléchit...', false);
    abortController = new AbortController();
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, userId: currentUser.id, periode: currentPeriode, recursionDepth: 0 }),
            signal: abortController.signal
        });
        const result = await res.json();
        removeMessage(loadId);
        const instructions = Array.isArray(result) ? result : [result];
        for (const inst of instructions) await executeInstruction(inst);
        await refreshDashboard();
    } catch (err) {
        if (err.name === 'AbortError') {
            removeMessage(loadId);
            addChatMessage('system', '❌ Requête annulée.', true);
        } else {
            removeMessage(loadId);
            addChatMessage('ai', '❌ Erreur de connexion. Réessayez.');
            console.error(err);
        }
    } finally {
        waitingForResponse = false;
        abortController = null;
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
                let totalBalance = 0;
                for (let acc of accountsMap.values()) totalBalance += acc.balance;
                addChatMessage('ai', `💰 Solde total : ${totalBalance.toFixed(0)} F`);
                break;
            case 'query':
                if (inst.type === 'total') {
                    const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
                    addChatMessage('ai', `📊 Total dépenses : ${total.toFixed(0)} F`);
                } else if (inst.type === 'forecast') {
                    const today = new Date(), dim = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate(), dp = today.getDate();
                    const ts = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
                    const fc = Math.round((ts/(dp||1))*(dim-dp));
                    addChatMessage('ai', `📈 Prévision fin de mois : ~${fc}F supplémentaires.`);
                } else if (inst.type === 'best_days') {
                    const dm = new Map();
                    transactionsData.forEach(t => { if(t.type==='expense') { const d = new Date(t.date).getDay(); dm.set(d, (dm.get(d)||0)+t.amount); } });
                    let bd = null, bv = Infinity;
                    for (let [d, v] of dm) { if(v < bv) { bv = v; bd = d; } }
                    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
                    addChatMessage('ai', bd !== null ? `🔥 Moins de dépenses le ${days[bd]} (${bv}F).` : "Pas assez de données.");
                } else {
                    addChatMessage('ai', inst.message || 'Analyse effectuée.');
                }
                break;
            case 'clarify':
                addChatMessage('ai', inst.message || 'Précisez svp.');
                break;
            case 'answer':
                addChatMessage('ai', inst.message || '');
                break;
            default:
                addChatMessage('ai', "Je n'ai pas compris. Reformulez.");
        }
    } catch(err) { console.error(err); addChatMessage('ai','❌ Erreur exécution.'); }
}

// ==================== TRANSACTIONS ====================
async function handleAddTransaction(inst) {
    let catId = null;
    for (let [id,cat] of categoriesMap.entries()) { if (cat.name.toLowerCase()===(inst.category||'').toLowerCase()) { catId=id; break; } }
    if (!catId && inst.category) {
        const { data } = await db.from('categories').insert({ user_id:currentUser.id, name:inst.category, icon:'📌' }).select();
        if (data?.[0]) { catId=data[0].id; categoriesMap.set(catId,data[0]); }
    }
    let accId = null;
    for (let [id,acc] of accountsMap.entries()) { if (acc.name===inst.account) { accId=id; break; } }
    if (!accId) { addChatMessage('ai',`❌ Compte "${inst.account}" introuvable.`); return; }

    const isIncome = inst.action==='add_income';
    const { data, error } = await db.from('transactions').insert({
        user_id:currentUser.id, amount:inst.amount, description:inst.description,
        category_id:catId, account_id:accId, type:isIncome?'income':'expense',
        date:inst.date||new Date().toISOString().split('T')[0]
    }).select();
    if (!error && data?.[0]) {
        lastCreatedTransactionId = data[0].id;
        const acc = accountsMap.get(accId);
        const nb = isIncome ? acc.balance+inst.amount : acc.balance-inst.amount;
        await db.from('accounts').update({ balance:nb }).eq('id',accId);
        acc.balance = nb;
        updateBalancesDisplay();
        addChatMessage('ai', `${isIncome?'💰':'💸'} ${isIncome?'Revenu':'Dépense'} : ${inst.amount}F (${inst.category||'Autres'}) sur ${inst.account}`);
    } else { addChatMessage('ai','❌ Erreur ajout.'); }
}

async function handleAddToSavings(inst) {
    const src = inst.source||'cash';
    let srcId=null, epId=null;
    for (let [id,a] of accountsMap.entries()) { if(a.name===src) srcId=id; if(a.name==='epargne') epId=id; }
    if (!srcId||!epId) { addChatMessage('ai','❌ Compte introuvable.'); return; }
    const srcAcc=accountsMap.get(srcId), epAcc=accountsMap.get(epId);
    if (srcAcc.balance<inst.amount) { addChatMessage('ai',`❌ Solde ${src} insuffisant (${srcAcc.balance}F).`); return; }
    await db.from('accounts').update({ balance:srcAcc.balance-inst.amount }).eq('id',srcId);
    await db.from('accounts').update({ balance:epAcc.balance+inst.amount }).eq('id',epId);
    srcAcc.balance-=inst.amount; epAcc.balance+=inst.amount;
    updateBalancesDisplay();
    addChatMessage('ai',`💰 ${inst.amount}F transférés de ${src} vers épargne`);
}

async function handleDeleteTransaction(inst) {
    const transId = inst.transaction_id||lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai','❌ Aucune transaction à supprimer.'); return; }
    const { data:t } = await db.from('transactions').select('*').eq('id',transId).eq('user_id',currentUser.id).single();
    if (!t) { addChatMessage('ai','❌ Transaction introuvable.'); return; }
    const acc = accountsMap.get(t.account_id);
    if (acc) {
        const nb = t.type==='income' ? acc.balance-t.amount : acc.balance+t.amount;
        await db.from('accounts').update({ balance:nb }).eq('id',t.account_id);
        acc.balance=nb; updateBalancesDisplay();
    }
    const { error } = await db.from('transactions').delete().eq('id',transId).eq('user_id',currentUser.id);
    if (!error) { if(lastCreatedTransactionId===transId) lastCreatedTransactionId=null; addChatMessage('ai',`🗑️ Supprimé : ${t.amount}F - ${t.description||'sans description'}`); }
    else addChatMessage('ai','❌ Erreur suppression.');
}

async function handleUpdateTransaction(inst) {
    const transId = inst.transaction_id||lastCreatedTransactionId;
    if (!transId) { addChatMessage('ai','❌ Aucune transaction à modifier.'); return; }
    const { data:t } = await db.from('transactions').select('*').eq('id',transId).eq('user_id',currentUser.id).single();
    if (!t) { addChatMessage('ai','❌ Transaction introuvable.'); return; }
    const oldAcc = accountsMap.get(t.account_id);
    if (oldAcc) { const nb=t.type==='income'?oldAcc.balance-t.amount:oldAcc.balance+t.amount; await db.from('accounts').update({balance:nb}).eq('id',t.account_id); oldAcc.balance=nb; }
    const f=inst.fields_to_update||{}, upd={};
    if(f.amount!==undefined) upd.amount=f.amount;
    if(f.description!==undefined) upd.description=f.description;
    if(f.date!==undefined) upd.date=f.date;
    let newAccId=t.account_id;
    if(f.account) { for(let [id,a] of accountsMap.entries()) { if(a.name===f.account){newAccId=id;break;} } upd.account_id=newAccId; }
    if(f.category) {
        let cId=null;
        for(let [id,c] of categoriesMap.entries()) { if(c.name.toLowerCase()===f.category.toLowerCase()){cId=id;break;} }
        if(!cId) { const {data}=await db.from('categories').insert({user_id:currentUser.id,name:f.category,icon:'📌'}).select(); if(data?.[0]){cId=data[0].id;categoriesMap.set(cId,data[0]);} }
        if(cId) upd.category_id=cId;
    }
    const {error}=await db.from('transactions').update(upd).eq('id',transId);
    if(!error) {
        const nAcc=accountsMap.get(newAccId), nAmt=upd.amount!==undefined?upd.amount:t.amount;
        if(nAcc){ const delta = t.type==='income' ? nAmt : -nAmt; await db.from('accounts').update({balance:nAcc.balance+delta}).eq('id',newAccId); nAcc.balance+=delta; }
        updateBalancesDisplay(); addChatMessage('ai','✏️ Transaction modifiée.');
    } else addChatMessage('ai','❌ Erreur modification.');
}

async function handleAddAccount(inst) {
    const name=(inst.new_name||'').toLowerCase().replace(/\s+/g,'_');
    if(!name){addChatMessage('ai','❌ Nom invalide.');return;}
    const {data,error}=await db.from('accounts').insert({user_id:currentUser.id,name,balance:inst.balance||0}).select();
    if(!error&&data?.[0]){accountsMap.set(data[0].id,data[0]);updateBalancesDisplay();addChatMessage('ai',`🏦 Compte "${name}" créé.`);}
    else addChatMessage('ai','❌ Erreur création compte.');
}

async function handleUpdateAccount(inst) {
    let accId=null;
    for(let [id,a] of accountsMap.entries()){if(a.name===inst.old_name){accId=id;break;}}
    if(!accId){addChatMessage('ai',`❌ Compte "${inst.old_name}" introuvable.`);return;}
    const newName=(inst.new_name||'').toLowerCase().replace(/\s+/g,'_');
    const upd={name:newName};if(inst.balance!==undefined) upd.balance=inst.balance;
    const {error}=await db.from('accounts').update(upd).eq('id',accId);
    if(!error){const a=accountsMap.get(accId);a.name=newName;if(inst.balance!==undefined)a.balance=inst.balance;updateBalancesDisplay();addChatMessage('ai',`🏦 Renommé : "${inst.old_name}" → "${newName}".`);}
}

// ==================== MODALS ====================
function openTransactionModal(mode='add', transactionId=null) {
    const modal=document.getElementById('transactionModal');
    document.getElementById('transactionModalTitle').textContent=mode==='edit'?'✏️ Modifier':'➕ Ajouter transaction';
    const form=document.getElementById('transactionForm');
    form.dataset.mode=mode; form.dataset.transactionId=transactionId||'';
    const catSel=document.getElementById('transCategory'), accSel=document.getElementById('transAccount');
    catSel.innerHTML='<option value="">-- Catégorie --</option>'+Array.from(categoriesMap.values()).map(c=>`<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
    accSel.innerHTML='<option value="">-- Compte --</option>'+Array.from(accountsMap.values()).map(a=>`<option value="${a.id}">${getAccountEmoji(a.name)} ${a.name}</option>`).join('');
    if(mode==='edit'&&transactionId){
        const t=transactionsData.find(x=>x.id===transactionId);
        if(t){document.getElementById('transAmount').value=t.amount;document.getElementById('transDescription').value=t.description||'';document.getElementById('transType').value=t.type;document.getElementById('transDate').value=t.date;catSel.value=t.category_id||'';accSel.value=t.account_id||'';}
    } else { form.reset(); document.getElementById('transDate').value=new Date().toISOString().split('T')[0]; }
    modal.style.display='flex';
}
async function saveTransactionForm() {
    const form=document.getElementById('transactionForm');
    const mode=form.dataset.mode, transId=form.dataset.transactionId;
    const amount=parseFloat(document.getElementById('transAmount').value);
    const description=document.getElementById('transDescription').value;
    const type=document.getElementById('transType').value;
    const date=document.getElementById('transDate').value;
    const accountId=document.getElementById('transAccount').value;
    const categoryId=document.getElementById('transCategory').value;
    if(!amount||!accountId){alert('Montant et compte obligatoires');return;}
    if(mode==='edit'&&transId){
        await handleUpdateTransaction({transaction_id:transId,fields_to_update:{amount,description,type,date,account:accountsMap.get(accountId)?.name,category:categoriesMap.get(categoryId)?.name}});
    } else {
        await handleAddTransaction({action:type==='income'?'add_income':'add_expense',amount,description,category:categoriesMap.get(categoryId)?.name||'Autres',account:accountsMap.get(accountId)?.name,date});
    }
    closeModal('transactionModal'); await refreshDashboard();
}
window.editTransaction = async function(id) { openTransactionModal('edit', id); };
window.deleteTransaction = async function(id) { if(!confirm('Supprimer ?')) return; await handleDeleteTransaction({transaction_id:id}); await refreshDashboard(); };

function openAccountsModal(){
    const modal=document.getElementById('accountsModal'), listDiv=document.getElementById('accountsList');
    listDiv.innerHTML='';
    for(let acc of accountsMap.values()){
        const item=document.createElement('div');item.className='account-item';
        item.innerHTML=`<span>${getAccountEmoji(acc.name)} ${acc.name}: ${acc.balance} F</span><div><button class="btn-icon" onclick="editAccount('${acc.id}')">✏️</button><button class="btn-icon" onclick="deleteAccount('${acc.id}')">🗑️</button></div>`;
        listDiv.appendChild(item);
    }
    modal.style.display='flex';
}
async function addAccountManual(){
    const name=document.getElementById('newAccountName').value.trim().toLowerCase().replace(/\s+/g,'_');
    const balance=parseFloat(document.getElementById('newAccountBalance').value)||0;
    if(!name)return;
    await handleAddAccount({new_name:name,balance});
    document.getElementById('newAccountName').value='';document.getElementById('newAccountBalance').value='';
    openAccountsModal();
}
window.editAccount = async function(id){
    const acc=accountsMap.get(id); if(!acc)return;
    const n=prompt('Nouveau nom:',acc.name);
    if(n&&n!==acc.name){await handleUpdateAccount({old_name:acc.name,new_name:n});openAccountsModal();}
};
window.deleteAccount = async function(id){
    const acc=accountsMap.get(id);if(!acc||!confirm(`Supprimer "${acc.name}" ?`))return;
    const {error}=await db.from('accounts').delete().eq('id',id).eq('user_id',currentUser.id);
    if(!error){accountsMap.delete(id);updateBalancesDisplay();openAccountsModal();await refreshDashboard();}
};
function closeModal(id){document.getElementById(id).style.display='none';}

async function showCategoriesModal(){
    const modal=document.getElementById('categoriesModal'),listDiv=document.getElementById('categoriesList');
    listDiv.innerHTML='';
    for(let cat of categoriesMap.values()){
        const item=document.createElement('div');
        item.innerHTML=`<span>${cat.icon} ${cat.name}</span>`;
        const btn=document.createElement('button');btn.textContent='🗑️';btn.onclick=()=>deleteCategory(cat.id);
        item.appendChild(btn);listDiv.appendChild(item);
    }
    modal.style.display='flex';
}
async function deleteCategory(id){await db.from('categories').delete().eq('id',id);await loadUserData();showCategoriesModal();}
async function addCategory(){
    const name=document.getElementById('newCategoryName').value.trim();
    const icon=document.getElementById('newCategoryIcon').value||'📌';
    if(!name)return;
    await db.from('categories').insert({user_id:currentUser.id,name,icon});
    await loadUserData();showCategoriesModal();
    document.getElementById('newCategoryName').value='';document.getElementById('newCategoryIcon').value='';
}

// ==================== EVENTS ====================
document.getElementById('loginBtn').onclick = login;
document.getElementById('registerBtn').onclick = register;
document.getElementById('logoutBtn').onclick = logout;
document.getElementById('sendBtn').onclick = sendMessage;
document.getElementById('applyCustomBtn').onclick = setPeriodeCustom;
document.querySelectorAll('.filter-btn').forEach(b => b.onclick = () => loadPeriod(b.dataset.period));
document.getElementById('manageCategoriesBtn').onclick = showCategoriesModal;
document.getElementById('addCategoryBtn').onclick = addCategory;
const addTxBtn = document.getElementById('addTransactionBtn'); if(addTxBtn) addTxBtn.onclick = () => openTransactionModal('add');
const manageAccBtn = document.getElementById('manageAccountsBtn'); if(manageAccBtn) manageAccBtn.onclick = openAccountsModal;
const addAccBtn = document.getElementById('addAccountBtn'); if(addAccBtn) addAccBtn.onclick = addAccountManual;
document.querySelectorAll('.close').forEach(b => b.onclick = () => b.closest('.modal') && (b.closest('.modal').style.display = 'none'));
window.onclick = e => { if(e.target.classList.contains('modal')) e.target.style.display = 'none'; };
userInput.addEventListener('keydown', e => { if(e.key === 'Enter') sendMessage(); });
checkAuth();
