// ==================== CONFIGURATION ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ==================== FONCTIONS UTILITAIRES ====================
async function fetchFromSupabase(table, params) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
    const resp = await fetch(url, {
        headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
    });
    if (!resp.ok) return [];
    return resp.json();
}

async function callDeepSeek(messages, temperature = 0.3) {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: messages,
            temperature: temperature,
            max_tokens: 1000
        })
    });
    
    if (!response.ok) throw new Error(`DeepSeek API error: ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// ==================== SAUVEGARDE HISTORIQUE ====================
async function saveChatHistory(userId, userMessage, assistantResponse, action = null) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                role: 'user',
                content: userMessage,
                created_at: new Date().toISOString()
            }),
        });

        const assistantContent = typeof assistantResponse === 'string' 
            ? assistantResponse 
            : (assistantResponse.message || JSON.stringify(assistantResponse));
        
        await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                role: 'assistant',
                content: assistantContent,
                action: action || (assistantResponse.action || null),
                metadata: assistantResponse,
                created_at: new Date().toISOString()
            }),
        });
    } catch (e) {
        console.warn('Erreur sauvegarde historique:', e.message);
    }
}

// ==================== FETCH TRANSACTIONS AVEC FILTRES AVANCÉS ====================
async function handleFetchTransactions(userId, periode, filter) {
    let params = `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=date.desc&limit=100`;

    if (filter.type) params += `&type=eq.${filter.type}`;
    if (periode?.debut) params += `&date=gte.${periode.debut}`;
    if (periode?.fin) params += `&date=lte.${periode.fin}`;
    if (filter.amount_gt) params += `&amount=gt.${filter.amount_gt}`;
    if (filter.amount_lt) params += `&amount=lt.${filter.amount_lt}`;
    if (filter.category_id) params += `&category_id=eq.${filter.category_id}`;
    if (filter.account_id) params += `&account_id=eq.${filter.account_id}`;

    let transactions = await fetchFromSupabase('transactions', params);
    
    // Filtres supplémentaires côté client
    if (filter.category && !filter.category_id) {
        transactions = transactions.filter(t => 
            t.categories?.name?.toLowerCase().includes(filter.category.toLowerCase())
        );
    }
    if (filter.account && !filter.account_id) {
        transactions = transactions.filter(t => 
            t.accounts?.name?.toLowerCase() === filter.account.toLowerCase()
        );
    }
    if (filter.search) {
        transactions = transactions.filter(t => 
            t.description?.toLowerCase().includes(filter.search.toLowerCase())
        );
    }

    if (transactions.length === 0) {
        return "Aucune transaction trouvée pour ces critères.";
    }

    const total = transactions.reduce((s, t) => s + t.amount, 0);
    const expenseTotal = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const incomeTotal = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    
    const lines = transactions.slice(0, 20).map(t =>
        `• ${t.date} — ${t.type === 'expense' ? '-' : '+'}${t.amount}F (${t.categories?.name || '?'}) sur ${t.accounts?.name || '?'}${t.description ? ' — ' + t.description.substring(0, 40) : ''}`
    ).join('\n');

    const suffix = transactions.length > 20 ? `\n\n... et ${transactions.length - 20} autres.` : '';
    
    return `${transactions.length} transaction(s) trouvée(s)\n📊 Total: ${total}F (dépenses: ${expenseTotal}F, revenus: ${incomeTotal}F)\n\n${lines}${suffix}`;
}

async function handleFetchBalance(userId) {
    const accountsList = await fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`);
    const total = accountsList.reduce((s, a) => s + (a.balance || 0), 0);
    const details = accountsList.map(a => `${a.name}: ${a.balance}F`).join(', ');
    return `💰 Solde total : ${total}F\n(${details})`;
}

// ==================== CHAT NORMAL (lecture seule) ====================
async function handleChat(req, res) {
    const { userId, message, history, periode, accounts, categories, transactions, currentDate } = req.body;
    
    const accountsCtx = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');
    const categoriesCtx = categories.map(c => `${c.icon}${c.name}`).join(', ');
    const transCtx = transactions.slice(0, 5).map(t =>
        `[ID:${t.id}] ${t.date} | ${t.type} | ${t.amount}F | ${t.categories?.name || '?'}`
    ).join('\n');

    const systemPrompt = `Tu es Xaalis, un assistant financier. Tu réponds aux questions sur les données.

=== CONTEXTE ===
Date: ${currentDate}
Comptes: ${accountsCtx}
Catégories: ${categoriesCtx}
Dernières transactions:
${transCtx || 'Aucune'}

=== RÈGLES ===
- Réponds uniquement en JSON
- Pour fetch_balance: {"action":"fetch_balance","requiresConfirmation":false}
- Pour fetch_transactions: {"action":"fetch_transactions","filter":{"type":"expense","category":"Courses","amount_gt":1000}}
- Pour réponse texte: {"action":"answer","message":"..."}

Message: "${message}"`;

    const raw = await callDeepSeek([
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
    ]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw, requiresConfirmation: false };
    
    // Traiter fetch_transactions
    if (result.action === 'fetch_transactions') {
        const messageText = await handleFetchTransactions(userId, periode, result.filter || {});
        result.action = 'answer';
        result.message = messageText;
        result.requiresConfirmation = false;
    }
    
    if (result.action === 'fetch_balance') {
        result.message = await handleFetchBalance(userId);
        result.action = 'answer';
        result.requiresConfirmation = false;
    }
    
    await saveChatHistory(userId, message, result, result.action);
    res.status(200).json(result);
}

// ==================== COMPRENDRE (premier appel - actions) ====================
async function handleUnderstand(req, res) {
    const { userId, message, recentActions, accounts, categories, currentDate } = req.body;
    
    const accountsText = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');
    const categoriesList = categories.map(c => `"${c.name}"`).join(', ');
    const recentActionsText = recentActions.slice(0, 5).map(a => 
        `- ${a.action} (ID: ${a.transaction_id?.slice(-8) || 'N/A'}, montant: ${a.amount || '?'}F) à ${new Date(a.timestamp).toLocaleTimeString()}`
    ).join('\n');

    const systemPrompt = `Tu es Xaalis, un assistant financier EXPERT. INTERPRÈTE la demande et retourne du JSON.

=== CONTEXTE ===
Date aujourd'hui: ${currentDate}
Comptes: ${accountsText}
Catégories disponibles: ${categoriesList}
Actions récentes exécutées:
${recentActionsText || 'Aucune'}

=== RÈGLES PRIORITAIRES ===
⚠️ Si l'utilisateur dit "non", "en fait", "c'était", "plutôt", "corrige", "annule" → C'est une CORRECTION de la dernière action.
   Pour corriger un montant: {"action":"update_transaction","transaction_id":"ID","fields_to_update":{"amount":NOUVEAU}}
   Pour annuler: {"action":"delete_transaction","transaction_id":"ID"}

=== ACTIONS DISPONIBLES ===

1. DÉPENSE unique:
{"action":"add_expense","amount":2000,"description":"resto","category":"Restaurant","account":"cash","date":"${currentDate}","requiresConfirmation":true,"confirmationMessage":"💰 Ajouter 2000F pour resto (Restaurant) sur cash ?"}

2. REVENU unique:
{"action":"add_income","amount":500000,"description":"salaire","category":"Salaire","account":"wave","requiresConfirmation":true,"confirmationMessage":"💰 Ajouter 500000F de revenu (Salaire) sur wave ?"}

3. ACTIONS MULTIPLES (ET):
{"actions":[
    {"action":"add_expense","amount":200,"description":"pain","category":"Courses","account":"cash","requiresConfirmation":true},
    {"action":"add_expense","amount":500,"description":"saucisson","category":"Courses","account":"cash","requiresConfirmation":true}
],"confirmationMessage":"💰 Confirmer :\\n- 200F pour pain\\n- 500F pour saucisson"}

4. SUPPRESSION MULTIPLE (toutes les dépenses d'un jour):
{"action":"delete_query","query":{"table":"transactions","filter":{"type":"expense","date":"${currentDate}"}},"requiresConfirmation":true,"confirmationMessage":"⚠️ Supprimer TOUTES les dépenses d'aujourd'hui (${currentDate}) ?"}

5. SUPPRESSION PAR CATÉGORIE:
{"action":"delete_query","query":{"table":"transactions","filter":{"type":"expense","category":"Courses","date":"${currentDate}"}},"requiresConfirmation":true,"confirmationMessage":"⚠️ Supprimer toutes les Courses d'aujourd'hui ?"}

6. MODIFICATION MULTIPLE (re-catégoriser):
{"action":"update_query","query":{"table":"transactions","filter":{"type":"expense","date":"${currentDate}"},"update":{"category":"NouvelleCatégorie"}},"requiresConfirmation":true,"confirmationMessage":"✏️ Re-catégoriser toutes les dépenses d'aujourd'hui ?"}

7. TRANSFERT ÉPARGNE:
{"action":"add_to_savings","amount":10000,"source":"cash","requiresConfirmation":true,"confirmationMessage":"💰 Transférer 10000F vers épargne depuis cash ?"}

=== RÈGLES ===
- Compte par défaut: "cash"
- Catégorie par défaut: "Autres"
- Date par défaut: aujourd'hui
- Retourne UNIQUEMENT du JSON valide

Message: "${message}"`;

    const raw = await callDeepSeek([{ role: 'system', content: systemPrompt }]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { 
        action: 'clarify', 
        message: "Je n'ai pas compris. Pouvez-vous reformuler ?",
        requiresConfirmation: false 
    };
    
    await saveChatHistory(userId, message, result, result.action);
    res.status(200).json(result);
}

// ==================== EXÉCUTER (deuxième appel - confirmation) ====================
async function handleExecute(req, res) {
    const { userId, pendingAction, userResponse, accounts, currentDate } = req.body;
    
    const accountsText = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');

    const systemPrompt = `Tu es Xaalis, EXÉCUTEUR. Traite la réponse de l'utilisateur.

Action en attente: ${JSON.stringify(pendingAction)}
Réponse: "${userResponse}"
Comptes: ${accountsText}

Retourne UNIQUEMENT du JSON:

Confirmation (oui/o/yes/ok):
{"actionExecuted": ${JSON.stringify(pendingAction)}, "successMessage": "✅ Action exécutée.", "cancelled": false}

Annulation (non/n/annule/cancel):
{"actionExecuted": null, "cancelled": true}

Modification (c'était X/plutôt X):
{"updatedAction": ${JSON.stringify(pendingAction)} AVEC modifications, "newConfirmationMessage": "💰 Nouvelle confirmation ?", "cancelled": false}`;

    const raw = await callDeepSeek([{ role: 'system', content: systemPrompt }]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { actionExecuted: null, cancelled: true };
    
    res.status(200).json(result);
}

// ==================== ROUTE PRINCIPALE ====================
export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Body invalide' });
    }
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'Config Supabase manquante' });
    }
    if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({ error: 'Clé DeepSeek manquante' });
    }
    
    const { type } = req.query;
    
    try {
        if (type === 'understand') {
            return await handleUnderstand(req, res);
        }
        if (type === 'execute') {
            return await handleExecute(req, res);
        }
        return await handleChat(req, res);
    } catch (err) {
        console.error('API error:', err);
        return res.status(500).json({ 
            action: 'answer', 
            message: '❌ Erreur serveur. Réessayez.',
            requiresConfirmation: false 
        });
    }
}
