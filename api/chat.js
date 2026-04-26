export default async function handler(req, res) {
    // ====================== CORS & Méthode ======================
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ====================== Validation de base ======================
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Body invalide' });
    }

    const { userId, periode, history = [], recentActions = [] } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId requis' });
    if (!history.length) return res.status(400).json({ error: 'Historique vide' });

    const lastMessage = history[history.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
        return res.status(400).json({ error: 'Dernier message invalide' });
    }

    const message = lastMessage.content;
    const conversationHistory = history.slice(0, -1);

    // ====================== Vérification des variables d'environnement ======================
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ action: 'answer', message: '❌ Config Supabase manquante.' });
    }
    if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({ action: 'answer', message: '❌ Clé DeepSeek manquante.' });
    }

    // ====================== Fonctions utilitaires ======================
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

    // ====================== Récupération du contexte financier ======================
    const [accounts, categories, recentTransactions] = await Promise.all([
        fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`),
        fetchFromSupabase('categories', `user_id=eq.${userId}&select=*`),
        fetchFromSupabase(
            'transactions',
            `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=created_at.desc&limit=5`
        ),
    ]);

    const accountsCtx = accounts.map(a => `${a.name}: ${a.balance}F`).join(', ');
    const categoriesCtx = categories.map(c => `${c.icon}${c.name}`).join(', ');

    const transCtx = recentTransactions.map(t =>
        `[ID:${t.id}] ${t.date} | ${t.type} | ${t.amount}F | ${t.categories?.name || '?'} | ${t.accounts?.name || '?'} | "${(t.description || '').substring(0, 30)}"`
    ).join('\n');

    const recentActionsText = recentActions.length > 0
        ? recentActions.map(a => {
            const time = new Date(a.timestamp).toLocaleTimeString();
            return a.transaction_id
                ? `- ${a.action} (ID: ${a.transaction_id}) à ${time}`
                : `- ${a.action} à ${time}`;
        }).join('\n')
        : 'Aucune action récente';

    // ====================== Prompt système complet ======================
    const systemPrompt = `Tu es Xaalis, un assistant financier intelligent, naturel et conversationnel.

=== CONTEXTE FINANCIER ===
Période analysée: ${periode?.debut || '?'} au ${periode?.fin || '?'}
Comptes et soldes: ${accountsCtx}
Catégories disponibles: ${categoriesCtx}
5 dernières transactions:
${transCtx || 'Aucune transaction'}

=== DERNIÈRES ACTIONS EXÉCUTÉES ===
${recentActionsText}

=== TON COMPORTEMENT ===
Tu es un vrai assistant intelligent. Tu:
- Te souviens de TOUT ce qui a été dit dans cette conversation
- Fais des liens entre les messages (si quelqu'un dit "si" → c'est une confirmation de ta question précédente)
- Comprends le sens implicite, pas juste les mots-clés
- Réponds de façon naturelle et humaine
- Ne demandes jamais deux fois la même chose
- Admets honnêtement quand tu n'as pas une info plutôt que d'inventer
- Analyses les données disponibles pour répondre aux questions financières

=== RÈGLE DE CORRECTION PRIORITAIRE ⚠️ ===
Si l'utilisateur dit des mots comme: "non", "en fait", "plutôt", "je voulais dire", "correction", "annule", "finalement", "rectification" → cela CORRIGE la dernière action de la liste ci-dessus.

- Pour corriger un montant: génère {"action":"update_transaction","transaction_id":"ID_ICI","fields_to_update":{"amount":NOUVEAU_MONTANT}}
- Pour annuler: génère {"action":"delete_transaction","transaction_id":"ID_ICI"}
- Pour changer le compte: génère {"action":"update_transaction","transaction_id":"ID_ICI","fields_to_update":{"account":"NOUVEAU_COMPTE"}}
- Pour changer la catégorie: génère {"action":"update_transaction","transaction_id":"ID_ICI","fields_to_update":{"category":"NOUVELLE_CATEGORIE"}}

NE PAS créer une nouvelle transaction quand l'utilisateur corrige la précédente.

=== COMMENT RÉPONDRE ===
1. SI c'est une conversation normale (salut, merci, comment ça va, question générale):
   → Réponds en texte naturel, pas de JSON

2. SI c'est une action financière claire:
   → Réponds UNIQUEMENT avec un JSON valide sur une seule ligne

3. SI des informations manquent pour une action:
   → Demande UNIQUEMENT ce qui manque, de façon naturelle

=== ACTIONS JSON DISPONIBLES ===
Dépense: {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash","date":"2025-01-15"}
Revenu: {"action":"add_income","amount":500000,"description":"salaire","category":"Salaire","account":"wave"}
Épargne: {"action":"add_to_savings","amount":5000,"source":"cash"}
Supprimer: {"action":"delete_transaction","transaction_id":"uuid-ici"}
Modifier: {"action":"update_transaction","transaction_id":"uuid-ici","fields_to_update":{"amount":2000}}
Voir transactions: {"action":"fetch_transactions","filter":{"type":"expense","category":"Logement"}}
Solde total: {"action":"fetch_balance"}
Total dépenses: {"action":"query","type":"total"}
Prévision: {"action":"query","type":"forecast"}
Meilleurs jours: {"action":"query","type":"best_days"}
Réponse texte: {"action":"answer","message":"Ta réponse ici"}
Demande précision: {"action":"clarify","message":"Ta question ici"}

=== RÈGLES IMPORTANTES ===
- N'invente JAMAIS un montant s'il n'est pas donné → utilise clarify
- Le compte par défaut est "cash" sauf si précisé autrement
- La date par défaut est aujourd'hui sauf si précisée
- Si quelqu'un dit "si" ou "oui" → c'est une confirmation, exécute l'action discutée
- Si quelqu'un mentionne un achat → c'est probablement une dépense à enregistrer
- Pour les questions sur les données (loyer, dépenses par catégorie, etc.) → utilise fetch_transactions avec le bon filtre`;

    // ====================== Appel à DeepSeek ======================
    const deepseekResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                ...conversationHistory,
                { role: 'user', content: message },
            ],
            temperature: 0.3,
            max_tokens: 1000,
        }),
    });

    if (!deepseekResponse.ok) {
        throw new Error(`DeepSeek API error: ${deepseekResponse.status}`);
    }

    const deepseekData = await deepseekResponse.json();
    const raw = deepseekData.choices[0].message.content.trim();

    // ====================== Parsing flexible de la réponse ======================
    let instruction;
    try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            instruction = JSON.parse(jsonMatch[0]);
        } else {
            instruction = { action: 'answer', message: raw };
        }
    } catch {
        instruction = { action: 'answer', message: raw };
    }

    // ====================== Post-traitement des actions spécifiques ======================
    if (instruction.action === 'fetch_transactions') {
        instruction = await handleFetchTransactions(userId, periode, instruction.filter || {}, fetchFromSupabase);
    } else if (instruction.action === 'fetch_balance') {
        instruction = await handleFetchBalance(userId, fetchFromSupabase);
    }

    // ====================== Sauvegarde de l'historique ======================
    await saveChatHistory(userId, message, instruction, SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ====================== Réponse finale ======================
    return res.status(200).json(instruction);
}

// ====================== Fonctions externes ======================

async function handleFetchTransactions(userId, periode, filter, fetchFromSupabase) {
    let params = `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=date.desc&limit=50`;

    if (filter.type) params += `&type=eq.${filter.type}`;
    if (periode?.debut) params += `&date=gte.${periode.debut}`;
    if (periode?.fin) params += `&date=lte.${periode.fin}`;
    if (filter.amount_gt) params += `&amount=gt.${filter.amount_gt}`;
    if (filter.amount_lt) params += `&amount=lt.${filter.amount_lt}`;

    const transactions = await fetchFromSupabase('transactions', params);
    let filtered = transactions;

    // Filtres supplémentaires côté client
    if (filter.category) {
        filtered = filtered.filter(t => t.categories?.name?.toLowerCase().includes(filter.category.toLowerCase()));
    }
    if (filter.account) {
        filtered = filtered.filter(t => t.accounts?.name?.toLowerCase() === filter.account.toLowerCase());
    }
    if (filter.amount_gt) filtered = filtered.filter(t => t.amount > filter.amount_gt);
    if (filter.amount_lt) filtered = filtered.filter(t => t.amount < filter.amount_lt);

    if (filtered.length === 0) {
        return { action: 'answer', message: "Aucune transaction trouvée pour ces critères." };
    }

    const total = filtered.reduce((s, t) => s + t.amount, 0);
    const lines = filtered.map(t =>
        `• ${t.date} — ${t.amount}F (${t.categories?.name || '?'}) sur ${t.accounts?.name || '?'}${t.description ? ' — ' + t.description : ''}`
    ).join('\n');

    return {
        action: 'answer',
        message: `${filtered.length} transaction(s) trouvée(s) — Total: ${total}F\n\n${lines}`
    };
}

async function handleFetchBalance(userId, fetchFromSupabase) {
    const accountsList = await fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`);
    const total = accountsList.reduce((s, a) => s + (a.balance || 0), 0);
    const details = accountsList.map(a => `${a.name}: ${a.balance}F`).join(', ');

    return {
        action: 'answer',
        message: `💰 Solde total : ${total}F\n(${details})`
    };
}

async function saveChatHistory(userId, userMessage, instruction, supabaseUrl, supabaseKey) {
    try {
        // Sauvegarde du message utilisateur
        await fetch(`${supabaseUrl}/rest/v1/chat_history`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                role: 'user',
                content: userMessage,
            }),
        });

        // Sauvegarde de la réponse assistant
        const assistantContent = instruction.message || JSON.stringify(instruction);
        await fetch(`${supabaseUrl}/rest/v1/chat_history`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                role: 'assistant',
                content: assistantContent,
                action: instruction.action,
                metadata: instruction,
            }),
        });
    } catch (e) {
        console.warn('Erreur sauvegarde historique:', e.message);
    }
}
