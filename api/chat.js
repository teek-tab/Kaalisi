import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) return res.status(500).json({ action: 'answer', message: '❌ Clé DeepSeek manquante.' });

    const MAX_RECURSION = 2;
    try {
        // Données légères : comptes, catégories, 3 dernières transactions, 5 derniers messages
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

        const systemPrompt = `Tu es Kaalisi, assistant financier (FCFA).

**Données actuelles** (ne pas inventer) :
- Période: ${periode?.debut||'?'} → ${periode?.fin||'?'}
- Soldes: ${accountsCtx}
- Catégories: ${categoriesCtx}
- 3 dernières transactions :
${transCtx || 'Aucune'}

**Actions JSON possibles** (retourne tableau ou objet) :
- add_expense / add_income : {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash","date":"YYYY-MM-DD"}
- add_to_savings : {"action":"add_to_savings","amount":5000,"source":"cash"}
- delete_transaction : {"action":"delete_transaction","transaction_id":"UUID"}
- update_transaction : {"action":"update_transaction","transaction_id":"UUID","fields_to_update":{"amount":1500,"account":"wave"}}
- add_account / update_account : {"action":"add_account","new_name":"orange","balance":0}
- fetch_transactions : 🔥 pour récupérer des transactions supplémentaires (filtres: category, type, account, date_gte, date_lte, limit ≤ 50)
- fetch_categories : {"action":"fetch_categories"}
- query (total/forecast/best_days) : {"action":"query","type":"total"}
- clarify / answer : {"action":"clarify","message":"..."}

Règles :
- Pour "supprime toutes les dépenses restaurant" → renvoie d'abord fetch_transactions puis supprime.
- Pour modifier la dernière transaction, utilise l'ID de la liste ci-dessus.
- Ne jamais inventer de soldes.
- Réponds UNIQUEMENT en JSON, sans texte avant/après.`;

        let instruction = await callDeepSeek(systemPrompt, historyMessages, message, DEEPSEEK_API_KEY);

        // Gestion fetch_transactions / fetch_categories avec rappel (profondeur limitée)
        if (instruction.action === 'fetch_transactions' && recursionDepth < MAX_RECURSION) {
            const filter = instruction.filter || {};
            const allowedFilters = ['category', 'type', 'account', 'date_gte', 'date_lte'];
            let params = `user_id=eq.${userId}&select=*&order=date.desc&limit=${Math.min(filter.limit || 50, 50)}`;
            if (filter.category) params += `&categories.name=eq.${filter.category}`;
            if (filter.type) params += `&type=eq.${filter.type}`;
            if (filter.account) params += `&accounts.name=eq.${filter.account}`;
            if (filter.date_gte) params += `&date=gte.${filter.date_gte}`;
            if (filter.date_lte) params += `&date=lte.${filter.date_lte}`;
            const transactions = await fetchFromSupabase('transactions', params);
            const newContext = `Résultat de la recherche (${transactions.length} transactions) :\n` + transactions.map(t => `[ID:${t.id}] ${t.date} ${t.type} ${t.amount}F catégorie:${t.categories?.name||'?'} compte:${t.accounts?.name||'?'} desc:${t.description||''}`).join('\n');
            const newHistory = [...historyMessages, { role: 'user', content: message }, { role: 'assistant', content: JSON.stringify(instruction) }];
            instruction = await callDeepSeek(systemPrompt + '\n\n' + newContext, newHistory, "Maintenant, utilise ces données pour exécuter les actions demandées par l'utilisateur.", DEEPSEEK_API_KEY);
        }
        else if (instruction.action === 'fetch_categories' && recursionDepth < MAX_RECURSION) {
            const allCategories = categories.map(c => `${c.icon} ${c.name}`).join(', ');
            instruction = { action: 'answer', message: `📂 Catégories disponibles : ${allCategories}` };
        }

        // Sauvegarde historique (optionnelle)
        await supabase.from('chat_history').insert({ user_id: userId, role: 'user', content: message }).catch(()=>{});
        await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', content: instruction.message || JSON.stringify(instruction), action: instruction.action }).catch(()=>{});

        res.status(200).json(instruction);
    } catch (err) {
        console.error('Handler error:', err);
        res.status(500).json({ action: 'answer', message: '❌ Erreur serveur. Réessayez.' });
    }

    async function callDeepSeek(system, messages, userMsg, apiKey) {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'system', content: system }, ...messages, { role: 'user', content: userMsg }],
                temperature: 0.1,
                max_tokens: 800
            })
        });
        const data = await response.json();
        if (!data.choices?.[0]?.message?.content) throw new Error('DeepSeek invalid response');
        const raw = data.choices[0].message.content;
        const jsonMatch = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        try {
            return jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw };
        } catch {
            return { action: 'answer', message: raw };
        }
    }

    async function fetchFromSupabase(table, params) {
        const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?${params}`;
        const res = await fetch(url, {
            headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
        });
        if (!res.ok) return [];
        return res.json();
    }
}
