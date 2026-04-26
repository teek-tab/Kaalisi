export default async function handler(req, res) {
    // CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Body invalide' });

    const { message, userId, periode, recursionDepth = 0 } = req.body;
    if (!message || !userId) return res.status(400).json({ error: 'message et userId requis' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ action: 'answer', message: '❌ Config Supabase manquante.' });
    if (!DEEPSEEK_API_KEY) return res.status(500).json({ action: 'answer', message: '❌ Clé DeepSeek manquante.' });

    const MAX_RECURSION = 2;

    async function fetchFromSupabase(table, params) {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
        const res = await fetch(url, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            }
        });
        if (!res.ok) return [];
        return res.json();
    }

    try {
        // Récupérer les données légères
        const [accounts, categories, recentTransactions, chatHistoryRaw] = await Promise.all([
            fetchFromSupabase('accounts', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('categories', `user_id=eq.${userId}&select=*`),
            fetchFromSupabase('transactions', `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=created_at.desc&limit=3`),
            fetchFromSupabase('chat_history', `user_id=eq.${userId}&select=role,content&order=created_at.desc&limit=5`)
        ]);

        const historyMessages = Array.isArray(chatHistoryRaw) ? chatHistoryRaw.reverse().map(h => ({ role: h.role, content: h.content })) : [];
        const accountsCtx = accounts.map(a => `${a.name}:${a.balance}F`).join(', ');
        const categoriesCtx = categories.map(c => `${c.icon}${c.name}`).join(', ');
        const transCtx = recentTransactions.map(t => `[ID:${t.id}] ${t.date}|${t.type}|${t.amount}F|${t.categories?.name||'?'}|${t.accounts?.name||'?'}|"${(t.description||'').substring(0,30)}"`).join('\n');

        const systemPrompt = `Tu es Kaalisi, une assistante financière intelligente et concise qui gère le budget de l'utilisateur en FCFA.

**Règle critique (à suivre absolument)** :
- Pour TOUTE question concernant des données (revenus, dépenses, listes, totaux, historiques, statistiques, filtres par catégorie/compte/date/montant, etc.), tu NE réponds JAMAIS directement.
- Tu retournes IMMÉDIATEMENT l'action {"action":"fetch_transactions","filter":{...}} avec les filtres les plus pertinents possibles.
- Exemples :
  - "mes revenus" → {"action":"fetch_transactions","filter":{"type":"income"}}
  - "dépenses restaurant" → {"action":"fetch_transactions","filter":{"type":"expense","category":"Restaurant"}}
  - "dépenses > 5000 ce mois" → {"action":"fetch_transactions","filter":{"type":"expense","amount_gt":5000}}
  - "transactions cash avril" → {"action":"fetch_transactions","filter":{"account":"cash","date_gte":"2026-04-01","date_lte":"2026-04-30"}}
  - "liste toutes les dépenses" → {"action":"fetch_transactions","filter":{"type":"expense"}}

**Style** :
- Toujours concis. Pas de blabla.
- Synthèse par défaut (total + extrêmes). Liste détaillée seulement si l'utilisateur dit explicitement "liste", "donne", "affiche", "détaille".
- Réponds UNIQUEMENT avec un JSON valide. Aucun texte hors JSON.

**Données actuelles** (ne pas inventer) :
- Période : ${periode?.debut || '?'} au ${periode?.fin || '?'}
- Comptes et soldes : ${accountsCtx}
- Catégories : ${categoriesCtx}
- 3 dernières transactions :
${transCtx || 'Aucune'}

**Actions disponibles** : add_expense, add_income, add_to_savings, delete_transaction, update_transaction, add_account, update_account, fetch_transactions, fetch_balance, query, answer, clarify.

Réponds toujours en JSON valide.`;

        async function callDeepSeek(system, messages, userMsg) {
            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'system', content: system }, ...messages, { role: 'user', content: userMsg }],
                    temperature: 0.1,
                    max_tokens: 800,
                    response_format: { type: "json_object" }
                })
            });

            if (!response.ok) throw new Error(`DeepSeek API error: ${response.status}`);
            const data = await response.json();
            if (!data.choices?.[0]?.message?.content) throw new Error('DeepSeek invalid response');

            const raw = data.choices[0].message.content.trim();
            try {
                return JSON.parse(raw);
            } catch (e) {
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        return JSON.parse(jsonMatch[0]);
                    } catch {
                        return { action: 'answer', message: raw.substring(0, 200) };
                    }
                }
                return { action: 'answer', message: raw.substring(0, 200) };
            }
        }

        let instruction = await callDeepSeek(systemPrompt, historyMessages, message);

        // Gestion fetch_transactions avec rappel (une seule fois)
        if (instruction.action === 'fetch_transactions' && recursionDepth < MAX_RECURSION) {
            const filter = instruction.filter || {};
            let params = `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=date.desc&limit=${Math.min(filter.limit || 50, 50)}`;
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
                : transactions.map(t => `[${t.date}] ${t.type === 'income' ? '+' : '-'}${t.amount}F | ${t.categories?.name || '?'} | ${t.accounts?.name || '?'} | ${t.description || ''}`).join('\n');

            const answerPrompt = `Résultat de ta requête (${transactions.length} transaction(s)) :\n${resultsText}\n\nMaintenant, réponds naturellement et de manière TRÈS CONCISE (1 ou 2 phrases max) avec {"action":"answer","message":"..."}. Ne refais pas de fetch.`;
            instruction = await callDeepSeek(answerPrompt, [...historyMessages, { role: 'assistant', content: JSON.stringify(instruction) }], "Réponds maintenant avec les données reçues.");
        }

        // Sauvegarde historique (optionnelle, ne doit pas bloquer)
        try {
            await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, role: 'user', content: message })
            });
            await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, role: 'assistant', content: instruction.message || JSON.stringify(instruction), action: instruction.action })
            });
        } catch (e) { console.warn('Historique non sauvegardé:', e.message); }

        res.status(200).json(instruction);
    } catch (err) {
        console.error('Chat error:', err);
        res.status(200).json({ action: 'answer', message: '❌ Erreur serveur. Réessayez.' });
    }
}
