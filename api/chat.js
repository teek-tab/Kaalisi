export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { message, userId, periode, recursionDepth = 0 } = req.body;
    if (!message || !userId) return res.status(400).json({ error: 'message et userId requis' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ action: 'answer', message: '❌ Configuration manquante' });
    if (!DEEPSEEK_API_KEY) return res.status(500).json({ action: 'answer', message: '❌ Clé API manquante' });

    async function fetchFromSupabase(table, params) {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
        const res = await fetch(url, {
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
        });
        if (!res.ok) return [];
        return res.json();
    }

    try {
        const [accounts, categories, recentTransactions, chatHistoryRaw] = await Promise.all([
            fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('categories', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('transactions', `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=created_at.desc&limit=3`),
            fetchFromSupabase('chat_history', `user_id=eq.${userId}&select=role,content&order=created_at.desc&limit=5`)
        ]);

        const historyMessages = Array.isArray(chatHistoryRaw) ? chatHistoryRaw.reverse().map(h => ({ role: h.role, content: h.content })) : [];
        const accountsCtx = accounts.map(a => `${a.name}:${a.balance}F`).join(', ');
        const categoriesCtx = categories.map(c => `${c.icon}${c.name}`).join(', ');
        const transCtx = recentTransactions.map(t => `[ID:${t.id}] ${t.date} ${t.type} ${t.amount}F ${t.categories?.name || '?'}`).join('\n');

        const systemPrompt = `Tu es Kaalisi, assistant financier sympa et rapide.

Contexte:
- Période: ${periode?.debut || '?'} au ${periode?.fin || '?'}
- Catégories: ${categoriesCtx}
- Comptes: cash, wave, epargne

Règles:
- Dépense: "sandwich 1000F cash" → {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash"}
- Revenu: "salaire 500000F wave" → {"action":"add_income","amount":500000,"description":"salaire","category":"Salaire","account":"wave"}
- Épargne: "épargne 5000F" → {"action":"add_to_savings","amount":5000,"source":"cash"}
- Total: "combien ce mois" → {"action":"query","type":"total"}
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

        async function callDeepSeek(system, history, userMsg) {
            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userMsg }],
                    temperature: 0.2,
                    max_tokens: 500,
                    response_format: { type: "json_object" }
                })
            });
            const data = await response.json();
            const raw = data.choices[0].message.content.trim();
            try {
                return JSON.parse(raw);
            } catch {
                return { action: 'answer', message: raw };
            }
        }

        let instruction = await callDeepSeek(systemPrompt, historyMessages, message);

        // Gestion fetch_transactions (un seul rappel)
        if (instruction.action === 'fetch_transactions' && recursionDepth < 1) {
            const filter = instruction.filter || {};
            let params = `user_id=eq.${userId}&select=*&order=date.desc&limit=50`;
            if (filter.type) params += `&type=eq.${filter.type}`;
            if (filter.category) params += `&categories.name=eq.${filter.category}`;
            if (filter.account) params += `&accounts.name=eq.${filter.account}`;
            const transactions = await fetchFromSupabase('transactions', params);
            const resultsText = transactions.length === 0 ? "Aucune transaction." : transactions.map(t => `${t.date} ${t.type==='income'?'+':'-'}${t.amount}F ${t.categories?.name||'?'}`).join('\n');
            instruction = { action: 'answer', message: `${transactions.length} transaction(s):\n${resultsText}` };
        }

        res.status(200).json(instruction);
    } catch (err) {
        console.error(err);
        res.status(200).json({ action: 'answer', message: '❌ Erreur, réessaye.' });
    }
}
