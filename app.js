// ==================== CONFIGURATION ====================
const SUPABASE_URL = 'VOTRE_URL_SUPABASE';      // À remplacer
const SUPABASE_ANON_KEY = 'VOTRE_CLE_ANON';    // À remplacer

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentPeriode = { debut: '', fin: '' };
let categoriesMap = new Map(); // id -> {name, icon}
let accountsMap = new Map();   // id -> {name, balance}
let transactionsData = [];

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
    // Récupérer comptes
    const { data: accounts, error: accErr } = await db
        .from('accounts')
        .select('*')
        .eq('user_id', currentUser.id);
    if (!accErr) {
        accountsMap.clear();
        accounts.forEach(acc => accountsMap.set(acc.id, acc));
        updateBalancesDisplay();
    }
    // Récupérer catégories
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
    let cash = 0, wave = 0, epargne = 0;
    for (let acc of accountsMap.values()) {
        if (acc.name === 'cash') cash = acc.balance;
        if (acc.name === 'wave') wave = acc.balance;
        if (acc.name === 'epargne') epargne = acc.balance;
    }
    balancesDiv.innerHTML = `
        <span>💵 Cash: ${cash} F</span>
        <span>📱 Wave: ${wave} F</span>
        <span>💰 Épargne: ${epargne} F</span>
    `;
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
        .select('*, accounts(name), categories(name, icon)')
        .eq('user_id', currentUser.id)
        .gte('date', currentPeriode.debut)
        .lte('date', currentPeriode.fin)
        .order('date', { ascending: false });
    if (!error) transactionsData = data || [];
    else console.error(error);
}

// ==================== STATS & GRAPHIQUES ====================
function updateStats() {
    let total = 0;
    transactionsData.forEach(t => {
        if (t.type === 'expense') total += t.amount;
    });
    const nbJours = Math.max(1, Math.ceil(
        (new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)
    ));
    const avgPerDay = total / nbJours;
    statsContainer.innerHTML = `
        <div class="stat-card"><h3>💰 Dépenses totales</h3><div class="stat-number">${total.toFixed(0)} F</div></div>
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
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: ['#3b82f6', '#f97316', '#10b981', '#ef4444', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899']
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom' }
            }
        }
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
            <div class="transaction-item">
                <div>
                    <strong>${t.date}</strong> ${cat.icon} ${cat.name}
                    ${t.description ? ' - ' + t.description : ''}
                    <br><small>${account.name}</small>
                </div>
                <div style="font-weight:bold;color:${t.type === 'expense' ? '#ef4444' : '#10b981'}">
                    ${t.type === 'expense' ? '-' : '+'} ${t.amount} F
                </div>
            </div>
        `;
    }).join('');
}

// ==================== IA : APPEL BACKEND & EXÉCUTION ====================
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
                periode: currentPeriode,
                categories: Array.from(categoriesMap.values()),
                accounts: Array.from(accountsMap.values())
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
    if (inst.action === 'add_expense') {
        // Trouver ou créer catégorie
        let catId = null;
        for (let [id, cat] of categoriesMap.entries()) {
            if (cat.name.toLowerCase() === inst.category.toLowerCase()) catId = id;
        }
        if (!catId) {
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
        if (!accId) return addChatMessage('ai', '❌ Compte non trouvé (cash/wave/epargne)');

        const { error } = await db.from('transactions').insert({
            user_id: currentUser.id,
            amount: inst.amount,
            description: inst.description,
            category_id: catId,
            account_id: accId,
            type: 'expense',
            date: inst.date || new Date().toISOString().split('T')[0]
        });
        if (!error) {
            const account = accountsMap.get(accId);
            const newBalance = account.balance - inst.amount;
            await db.from('accounts').update({ balance: newBalance }).eq('id', accId);
            account.balance = newBalance;
            updateBalancesDisplay();
            addChatMessage('ai', `✅ Ajouté : ${inst.amount} F (${inst.category}) sur ${inst.account}`);
            await refreshDashboard();
        } else {
            addChatMessage('ai', '❌ Erreur ajout dépense');
        }
    }
    else if (inst.action === 'add_to_savings') {
        const sourceName = inst.source || 'cash';
        let sourceId = null, epargneId = null;
        for (let [id, acc] of accountsMap.entries()) {
            if (acc.name === sourceName) sourceId = id;
            if (acc.name === 'epargne') epargneId = id;
        }
        if (!sourceId || !epargneId) return addChatMessage('ai', '❌ Compte source ou épargne introuvable');
        const sourceAcc = accountsMap.get(sourceId);
        const epargneAcc = accountsMap.get(epargneId);
        if (sourceAcc.balance < inst.amount) return addChatMessage('ai', `❌ Solde ${sourceName} insuffisant`);

        await db.from('accounts').update({ balance: sourceAcc.balance - inst.amount }).eq('id', sourceId);
        await db.from('accounts').update({ balance: epargneAcc.balance + inst.amount }).eq('id', epargneId);
        sourceAcc.balance -= inst.amount;
        epargneAcc.balance += inst.amount;
        updateBalancesDisplay();
        addChatMessage('ai', `💰 ${inst.amount} F transférés de ${sourceName} vers épargne`);
        await refreshDashboard();
    }
    else if (inst.action === 'query') {
        if (inst.type === 'total') {
            const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
            addChatMessage('ai', inst.message || `📊 Total dépenses : ${total} F`);
        } else if (inst.type === 'forecast') {
            const today = new Date();
            const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
            const daysPassed = today.getDate();
            const totalSpent = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
            const avgPerDay = totalSpent / (daysPassed || 1);
            const forecast = avgPerDay * (daysInMonth - daysPassed);
            addChatMessage('ai', `📈 Prévision fin de mois : ~${Math.round(forecast)} F supplémentaires si vous gardez ce rythme.`);
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
                addChatMessage('ai', `🔥 Meilleur jour (moins de dépenses) : ${days[bestDay]} avec ${bestValue} F au total sur la période.`);
            } else {
                addChatMessage('ai', "Pas assez de données pour analyser les jours.");
            }
        } else {
            addChatMessage('ai', inst.message || 'Analyse effectuée.');
        }
    }
    else if (inst.action === 'answer') {
        addChatMessage('ai', inst.message);
    }
    else {
        // BUG CORRIGÉ : apostrophe dans une chaîne entre guillemets doubles
        addChatMessage('ai', "❓ Je n'ai pas compris. Reformulez (ex: \"sandwich 1000F cash\", \"épargne 5000F\", \"prévision\").");
    }
}

async function generateInsights() {
    const total = transactionsData.reduce((s, t) => t.type === 'expense' ? s + t.amount : s, 0);
    const nbJours = Math.max(1, Math.ceil(
        (new Date(currentPeriode.fin) - new Date(currentPeriode.debut)) / (1000 * 3600 * 24)
    ));
    const moyenne = total / nbJours;
    document.getElementById('insightsContent').innerHTML = `
        <p>📉 Dépense quotidienne moyenne : <strong>${moyenne.toFixed(0)} F</strong></p>
        <p>💡 ${moyenne > 5000 ? 'Attention, vos dépenses sont élevées.' : 'Bonne maîtrise du budget !'}</p>
    `;
}

function addChatMessage(sender, text) {
    const div = document.createElement('div');
    if (sender === 'user') {
        div.className = 'user-msg';
    } else if (sender === 'system') {
        div.className = 'system-msg';
    } else {
        div.className = 'ai-msg';
    }
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
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
document.querySelector('.close').onclick = () => {
    document.getElementById('categoriesModal').style.display = 'none';
};

// Permettre envoi avec Entrée
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Initialisation
checkAuth();
