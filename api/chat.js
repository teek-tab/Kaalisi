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

        const systemPrompt = `Tu es Kaalisi, assistant financier intelligent (FCFA).

**Données actuelles** (ne pas inventer) :
- Période: ${periode?.debut||'?'} au ${periode?.fin||'?'}
- Comptes et soldes: ${accountsCtx}
- Catégories: ${categoriesCtx}
- 3 dernières transactions:
${transCtx || 'Aucune'}

**Actions disponibles :**
- add_expense / add_income
- add_to_savings
- delete_transaction
- update_transaction
- add_account / update_account
- fetch_transactions (pour récupérer des données avec filtres: type, category, account, date_gte, date_lte, amount_gt, amount_lt)
- fetch_balance (pour le solde total de tous les comptes)

**Règles IMPORTANTES :**
- Sois CONCIS : une ou deux phrases maximum.
- Si l'utilisateur demande une liste ("donne", "liste", "affiche", "détaille") → liste avec dates et montants.
- Sinon, privilégie la synthèse : total + extrêmes.
- Ne raconte pas d'histoire, va droit au but.
- Exemple pour "mes revenus" : "3 revenus : 67000 F. Max : 50000 F (salaire, 02/04)."
- Exemple pour "donne mes dépenses nourriture" : "2 dépenses : 15/04 5000F courses, 18/04 2500F resto. Total : 7500F."

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après.`;

        let instruction = await callDeepSeek(systemPrompt, historyMessages, message, DEEPSEEK_API_KEY);

        // Gestion fetch_transactions avec rappel
        if (instruction.action === 'fetch_transactions' && recursionDepth < MAX_RECURSION) {
            const filter = instruction.filter || {};
            let params = `user_id=eq.${userId}&select=*&order=date.desc&limit=${Math.min(filter.limit || 50, 50)}`;
            if (filter.type) params += `&type=eq.${filter.type}`;
            if (filter.category) params += `&categories.name=eq.${filter.category}`;
            if (filter.account) params += `&accounts.name=eq.${filter.account}`;
            if (filter.date_gte) params += `&date=gte.${filter.date_gte}`;
            if (filter.date_lte) params += `&date=lte.${filter.date_lte}`;
            if (filter.amount_gt) params += `&amount=gt.${filter.amount_gt}`;
            if (filter.amount_lt) params += `&amount=lt.${filter.amount_lt}`;
            
            const transactions = await fetchFromSupabase('transactions', params);
            const newContext = `Résultat (${transactions.length} transactions) :\n` + transactions.map(t => `[ID:${t.id}] ${t.date} ${t.type} ${t.amount}F catégorie:${t.categories?.name||'?'} compte:${t.accounts?.name||'?'} desc:${t.description||''}`).join('\n');
            const newHistory = [...historyMessages, { role: 'user', content: message }, { role: 'assistant', content: JSON.stringify(instruction) }];
            instruction = await callDeepSeek(systemPrompt + '\n\n' + newContext, newHistory, "Maintenant réponds naturellement et concis avec ces données.", DEEPSEEK_API_KEY);
        }

        // Sauvegarde historique
        await supabase.from('chat_history').insert({ user_id: userId, role: 'user', content: message }).catch(()=>{});
        await supabase.from('chat_history').insert({ user_id: userId, role: 'assistant', content: instruction.message || JSON.stringify(instruction), action: instruction.action }).catch(()=>{});

        res.status(200).json(instruction);
    } catch (err) {
        console.error('Chat error:', err);
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
