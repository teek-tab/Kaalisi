export default async function handler(req, res) {
    // CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Body invalide' });

    const { message, userId, periode, history = [] } = req.body;
    if (!message || !userId) return res.status(400).json({ error: 'message et userId requis' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ action: 'answer', message: '❌ Config Supabase manquante.' });
    if (!DEEPSEEK_API_KEY) return res.status(500).json({ action: 'answer', message: '❌ Clé DeepSeek manquante.' });

    async function fetchFromSupabase(table, params) {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
        const resp = await fetch(url, {
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
        });
        if (!resp.ok) return [];
        return resp.json();
    }

    try {
        // Récupérer les données pour le contexte
        const [accounts, categories, recentTransactions] = await Promise.all([
            fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('categories', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('transactions', `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=created_at.desc&limit=3`)
        ]);

        const accountsCtx = accounts.map(a => `${a.name}:${a.balance}F`).join(', ');
        const categoriesCtx = categories.map(c => `${c.icon}${c.name}`).join(', ');
        const transCtx = recentTransactions.map(t => `[ID:${t.id}] ${t.date}|${t.type}|${t.amount}F|${t.categories?.name||'?'}|${t.accounts?.name||'?'}|"${(t.description||'').substring(0,30)}"`).join('\n');

        const systemPrompt = `Tu es Kaalisi, assistant financier sympa et rapide.

Contexte:
- Période: ${periode?.debut || '?'} au ${periode?.fin || '?'}
- Comptes et soldes: ${accountsCtx}
- Catégories disponibles: ${categoriesCtx}
- 3 dernières transactions:
${transCtx || 'Aucune'}

Règles:
- Dépense: "sandwich 1000F cash" → {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash"}
- Revenu: "salaire 500000F wave" → {"action":"add_income","amount":500000,"description":"salaire","category":"Salaire","account":"wave"}
- Épargne: "épargne 5000F" → {"action":"add_to_savings","amount":5000,"source":"cash"}
- Total dépenses: "combien ce mois" → {"action":"query","type":"total"}
- Prévision: "prévision" → {"action":"query","type":"forecast"}
- Meilleurs jours: "meilleurs jours" → {"action":"query","type":"best_days"}
- Mes revenus: "mes revenus" → {"action":"fetch_transactions","filter":{"type":"income"}}
- Mes dépenses: "mes dépenses" → {"action":"fetch_transactions","filter":{"type":"expense"}}
- Solde total: "solde total" → {"action":"fetch_balance"}
- Chat normal: "salut", "merci" → {"action":"answer","message":"Réponse naturelle"}

IMPORTANT:
- Si aucun montant n'est donné, ne l'invente PAS. Demande avec {"action":"clarify","message":"Quel montant ?"}
- Ne dis JAMAIS "Je n'ai pas compris". Utilise answer ou clarify.
- Sois concis.

Réponds UNIQUEMENT en JSON valide.`;

        async function callDeepSeek(system, historyMessages, userMsg) {
            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: system },
                        ...historyMessages,
                        { role: 'user', content: userMsg }
                    ],
                    temperature: 0.2,
                    max_tokens: 800,
                    response_format: { type: "json_object" }
                })
            });
            if (!response.ok) throw new Error(`DeepSeek API error: ${response.status}`);
            const data = await response.json();
            const raw = data.choices[0].message.content.trim();
            try {
                return JSON.parse(raw);
            } catch {
                return { action: 'answer', message: raw };
            }
        }

        // Appel à DeepSeek avec l'historique de la conversation actuelle (envoyé par le front)
        let instruction = await callDeepSeek(systemPrompt, history, message);

        // Sauvegarder les messages en base (pour analyse ultérieure, optionnel)
        try {
            await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, role: 'user', content: message })
            });
            const assistantContent = instruction.message || JSON.stringify(instruction);
            await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, role: 'assistant', content: assistantContent, action: instruction.action, metadata: instruction })
            });
        } catch(e) { console.warn('Erreur sauvegarde historique:', e.message); }

        // Simuler fetch_transactions (si demandé) – on exécute et on répond directement
        if (instruction.action === 'fetch_transactions') {
            const filter = instruction.filter || {};
            let params = `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=date.desc&limit=50`;
            if (filter.type) params += `&type=eq.${filter.type}`;
            if (filter.category) params += `&categories.name=eq.${filter.category}`;
            if (filter.account) params += `&accounts.name=eq.${filter.account}`;
            if (filter.date_gte) params += `&date=gte.${filter.date_gte}`;
            if (filter.date_lte) params += `&date=lte.${filter.date_lte}`;
            if (filter.amount_gt) params += `&amount=gt.${filter.amount_gt}`;
            if (filter.amount_lt) params += `&amount=lt.${filter.amount_lt}`;
            const transactions = await fetchFromSupabase('transactions', params);
            const resultsText = transactions.length === 0
                ? "Aucune transaction trouvée."
                : transactions.map(t => `${t.date} ${t.type==='income'?'+':'-'}${t.amount}F ${t.categories?.name||'?'} (${t.accounts?.name||'?'})`).join('\n');
            instruction = { action: 'answer', message: `${transactions.length} transaction(s) trouvée(s):\n${resultsText}` };
        } else if (instruction.action === 'fetch_balance') {
            const accountsList = await fetchFromSupabase('accounts', `user_id=eq.${userId}&select=balance`);
            const total = accountsList.reduce((s,a) => s + (a.balance || 0), 0);
            instruction = { action: 'answer', message: `💰 Solde total : ${total} F` };
        }

        res.status(200).json(instruction);
    } catch (err) {
        console.error('Chat error:', err);
        res.status(200).json({ action: 'answer', message: '❌ Erreur serveur. Réessayez.' });
    }
}
