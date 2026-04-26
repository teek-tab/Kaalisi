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
- Pour fetch_transactions: {"action":"fetch_transactions","filter":{},"requiresConfirmation":false}
- Pour query: {"action":"query","type":"total","requiresConfirmation":false}
- Pour réponse texte: {"action":"answer","message":"..."}

Message: "${message}"`;

    const raw = await callDeepSeek([
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
    ]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw, requiresConfirmation: false };
    
    // Traiter fetch_transactions si nécessaire
    if (result.action === 'fetch_transactions') {
        let params = `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=date.desc&limit=50`;
        if (result.filter?.type) params += `&type=eq.${result.filter.type}`;
        if (periode?.debut) params += `&date=gte.${periode.debut}`;
        if (periode?.fin) params += `&date=lte.${periode.fin}`;
        
        const transactions = await fetchFromSupabase('transactions', params);
        const total = transactions.reduce((s, t) => s + t.amount, 0);
        const lines = transactions.slice(0, 10).map(t =>
            `• ${t.date} — ${t.amount}F (${t.categories?.name || '?'})`
        ).join('\n');
        
        return res.status(200).json({
            action: 'answer',
            message: `${transactions.length} transaction(s) — Total: ${total}F\n\n${lines}`,
            requiresConfirmation: false
        });
    }
    
    if (result.action === 'fetch_balance') {
        const accountsList = await fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`);
        const total = accountsList.reduce((s, a) => s + (a.balance || 0), 0);
        const details = accountsList.map(a => `${a.name}: ${a.balance}F`).join(', ');
        return res.status(200).json({
            action: 'answer',
            message: `💰 Solde total : ${total}F (${details})`,
            requiresConfirmation: false
        });
    }
    
    res.status(200).json(result);
}

// ==================== COMPRENDRE (premier appel) ====================
async function handleUnderstand(req, res) {
    const { userId, message, recentActions, accounts, categories, currentDate } = req.body;
    
    const accountsText = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');
    const categoriesText = categories.map(c => `${c.icon}${c.name}`).join(', ');
    const recentActionsText = recentActions.slice(0, 3).map(a => 
        `- ${a.action} (${a.transaction_id ? 'ID:' + a.transaction_id : 'pas d\'ID'})`
    ).join('\n');

    const systemPrompt = `Tu es Xaalis, un assistant financier EXPERT. Ton rôle: INTERPRÉTER la demande.

=== CONTEXTE ===
Date aujourd'hui: ${currentDate}
Comptes: ${accountsText}
Catégories: ${categoriesText}
Actions récentes:
${recentActionsText || 'Aucune'}

=== RÈGLES ===
🔴 Actions qui modifient la DB → requiresConfirmation: true
🟢 Actions qui lisent → requiresConfirmation: false

Actions 🔴: add_expense, add_income, update_transaction, delete_transaction, add_to_savings, transfer
Actions 🟢: fetch_balance, fetch_transactions, query, answer, clarify

=== COMMENT RÉPONDRE ===

Action unique:
{
    "action": "add_expense",
    "amount": 200,
    "description": "pain",
    "category": "Courses",
    "account": "cash",
    "date": "${currentDate}",
    "requiresConfirmation": true,
    "confirmationMessage": "💰 Ajouter 200F pour pain (Courses) sur cash ?"
}

Actions multiples:
{
    "actions": [
        {"action":"add_expense","amount":200,"description":"pain","category":"Courses","account":"cash","requiresConfirmation":true},
        {"action":"add_expense","amount":500,"description":"saucisson","category":"Courses","account":"cash","requiresConfirmation":true}
    ],
    "confirmationMessage": "💰 Confirmer l'ajout de :\\n- 200F pour pain\\n- 500F pour saucisson"
}

Correction (mots: "non", "en fait", "c'était", "plutôt"):
{
    "action": "update_transaction",
    "transaction_id": "ID_DERNIERE",
    "fields_to_update": {"amount": 300},
    "requiresConfirmation": true,
    "confirmationMessage": "✏️ Modifier : montant = 300F ?"
}

Annulation:
{
    "action": "delete_transaction",
    "transaction_id": "ID_DERNIERE",
    "requiresConfirmation": true,
    "confirmationMessage": "⚠️ Supprimer la dernière transaction ? (irréversible)"
}

=== RÈGLES ===
- Compte par défaut: "cash"
- Catégorie par défaut: "Autres"
- Date par défaut: aujourd'hui
- Retourne UNIQUEMENT du JSON

Message: "${message}"`;

    const raw = await callDeepSeek([
        { role: 'system', content: systemPrompt }
    ]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { 
        action: 'clarify', 
        message: "Je n'ai pas compris. Pouvez-vous reformuler ?",
        requiresConfirmation: false 
    };
    
    res.status(200).json(result);
}

// ==================== EXÉCUTER (deuxième appel) ====================
async function handleExecute(req, res) {
    const { userId, pendingAction, userResponse, accounts, currentDate } = req.body;
    
    const accountsText = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');

    const systemPrompt = `Tu es Xaalis, un EXÉCUTEUR. Ton rôle: Traiter la réponse de l'utilisateur.

=== CONTEXTE ===
Action en attente: ${JSON.stringify(pendingAction)}
Réponse utilisateur: "${userResponse}"
Comptes: ${accountsText}
Date: ${currentDate}

=== TÂCHE ===
Retourne UNIQUEMENT un JSON.

Cas - Confirmation ("oui", "o", "yes", "ok"):
{
    "actionExecuted": ${JSON.stringify(pendingAction)},
    "successMessage": "✅ Transaction ajoutée avec succès.",
    "cancelled": false
}

Cas - Annulation ("non", "n", "annule", "cancel"):
{
    "actionExecuted": null,
    "cancelled": true
}

Cas - Modification ("c'était X", "plutôt X", "sur Y", "catégorie Z"):
{
    "updatedAction": ${JSON.stringify(pendingAction)} AVEC modifications,
    "newConfirmationMessage": "💰 Nouvelle confirmation : ajouter XF pour description sur compte Y ?",
    "cancelled": false
}

Réponse: "${userResponse}"`;

    const raw = await callDeepSeek([
        { role: 'system', content: systemPrompt }
    ]);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { actionExecuted: null, cancelled: true };
    
    res.status(200).json(result);
}

// ==================== ROUTE PRINCIPALE ====================
export default async function handler(req, res) {
    // CORS
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
    
    // Vérifier les clés
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
