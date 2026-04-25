export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Body invalide' });

    const { message, userId, periode } = req.body;
    if (!message || !userId) return res.status(400).json({ error: 'message et userId requis' });

    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!DEEPSEEK_API_KEY) return res.status(500).json({ action: 'answer', message: '❌ Clé DeepSeek manquante.' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ action: 'answer', message: '❌ Config Supabase manquante.' });

    async function supabaseGet(table, params) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            }
        });
        return r.json();
    }

    async function supabasePost(table, body) {
        await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(body)
        });
    }

    try {
        const [accounts, categories, recentTransactions, chatHistoryRaw] = await Promise.all([
            supabaseGet('accounts', `user_id=eq.${userId}&select=*`),
            supabaseGet('categories', `user_id=eq.${userId}&select=*`),
            supabaseGet('transactions', `user_id=eq.${userId}&select=*,categories(name,icon),accounts(name)&order=created_at.desc&limit=5`),
            supabaseGet('chat_history', `user_id=eq.${userId}&select=role,content&order=created_at.desc&limit=10`)
        ]);

        const historyMessages = Array.isArray(chatHistoryRaw)
            ? chatHistoryRaw.reverse().map(h => ({ role: h.role, content: h.content }))
            : [];

        const accountsCtx = Array.isArray(accounts) ? accounts.map(a => `${a.name}:${a.balance}F`).join(', ') : '';
        const categoriesCtx = Array.isArray(categories) ? categories.map(c => `${c.icon}${c.name}`).join(', ') : '';
        const transCtx = Array.isArray(recentTransactions)
            ? recentTransactions.map(t => `[ID:${t.id}] ${t.date}|${t.type}|${t.amount}F|${t.categories?.name||'?'}|${t.accounts?.name||'?'}|"${t.description||''}"`)
              .join('\n')
            : 'Aucune';

        const systemPrompt = `Tu es Kaalisi, assistant financier intelligent (FCFA).

DONNÉES:
- Période: ${periode?.debut||'?'} au ${periode?.fin||'?'}
- Comptes: ${accountsCtx}
- Catégories: ${categoriesCtx}
- 5 dernières transactions:
${transCtx}

RÈGLES:
- Comprends le langage naturel français
- Si correction ("non","c'était wave","pas cash") → update_transaction sur la dernière transaction
- Si ambigu → clarify avec propositions numérotées
- Déduis catégorie: sandwich→Restaurant, taxi→Transport, médicament→Santé
- Ne crée JAMAIS 2 transactions pour la même chose

RÉPONSE JSON UNIQUEMENT:
Dépense: {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash","date":"YYYY-MM-DD"}
Revenu: {"action":"add_income","amount":50000,"description":"salaire","account":"wave","date":"YYYY-MM-DD"}
Épargne: {"action":"add_to_savings","amount":5000,"source":"cash"}
Supprimer: {"action":"delete_transaction","transaction_id":"UUID"}
Modifier: {"action":"update_transaction","transaction_id":"UUID","fields_to_update":{"account":"wave"}}
Nouveau compte: {"action":"add_account","new_name":"orange_money","balance":0}
Renommer: {"action":"update_account","old_name":"cash","new_name":"liquide"}
Total: {"action":"query","type":"total","message":""}
Prévision: {"action":"query","type":"forecast"}
Meilleurs jours: {"action":"query","type":"best_days"}
Clarifier: {"action":"clarify","message":"Voulez-vous :\\n1️⃣ ...\\n2️⃣ ..."}
Réponse: {"action":"answer","message":"..."}`;

        const dsRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'system', content: systemPrompt }, ...historyMessages, { role: 'user', content: message }],
                temperature: 0.1,
                max_tokens: 500
            })
        });

        const dsData = await dsRes.json();
        if (!dsData.choices?.[0]?.message?.content) {
            console.error('DeepSeek error:', JSON.stringify(dsData));
            return res.status(200).json({ action: 'answer', message: '❌ IA temporairement indisponible.' });
        }

        const raw = dsData.choices[0].message.content;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        let instruction;
        try { instruction = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw }; }
        catch (e) { instruction = { action: 'answer', message: raw }; }

        // Sauvegarder historique
        await supabasePost('chat_history', { user_id: userId, role: 'user', content: message, action: null, metadata: { periode } });
        await supabasePost('chat_history', { user_id: userId, role: 'assistant', content: instruction.message || JSON.stringify(instruction), action: instruction.action, metadata: instruction });

        return res.status(200).json(instruction);

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ action: 'answer', message: '❌ Erreur serveur. Réessayez.' });
    }
}
