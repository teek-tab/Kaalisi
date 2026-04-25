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
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
        });
        return r.json();
    }

    async function supabasePost(table, body) {
        await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
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
        const transCtx = Array.isArray(recentTransactions) && recentTransactions.length
            ? recentTransactions.map(t => `[ID:${t.id}] ${t.date}|${t.type}|${t.amount}F|${t.categories?.name||'?'}|${t.accounts?.name||'?'}|"${t.description||''}"`).join('\n')
            : 'Aucune';

        const systemPrompt = `Tu es Kaalisi, assistant financier intelligent (FCFA).

DONNÉES RÉELLES EN BASE:
- Période: ${periode?.debut||'?'} au ${periode?.fin||'?'}
- Comptes et soldes actuels: ${accountsCtx}
- Catégories: ${categoriesCtx}
- 5 dernières transactions (utilise ces IDs pour modifier/supprimer):
${transCtx}

RÈGLES CRITIQUES:
1. Tu peux retourner UN TABLEAU JSON pour exécuter plusieurs actions d'un coup
2. Exemple multi-actions: [{"action":"add_income",...}, {"action":"add_expense",...}, {"action":"add_expense",...}]
3. Si correction ("non","c'était wave","pas cash") → update_transaction sur la dernière transaction listée ci-dessus
4. Si l'utilisateur dit "supprime toutes" → retourne un tableau avec un delete_transaction par transaction
5. Ne JAMAIS inventer des soldes — utilise uniquement les données fournies ci-dessus
6. Déduis la catégorie: sandwich/resto→Restaurant, taxi/transport→Transport, loyer/maison→Logement, médicament→Santé, don/cadeau→Autres

FORMAT DE RÉPONSE — JSON uniquement, pas de texte:

Action unique:
{"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash","date":"2026-04-25"}

Actions multiples (tableau):
[
  {"action":"add_income","amount":300000,"description":"Don de maman","category":"Autres","account":"cash","date":"2026-04-23"},
  {"action":"add_expense","amount":80000,"description":"Loyer mai","category":"Logement","account":"cash","date":"2026-04-23"},
  {"action":"add_expense","amount":80000,"description":"Loyer juin","category":"Logement","account":"cash","date":"2026-04-23"}
]

Toutes les actions disponibles:
- {"action":"add_expense","amount":N,"description":"...","category":"...","account":"cash|wave|epargne","date":"YYYY-MM-DD"}
- {"action":"add_income","amount":N,"description":"...","account":"...","date":"YYYY-MM-DD"}
- {"action":"add_to_savings","amount":N,"source":"cash"}
- {"action":"delete_transaction","transaction_id":"UUID"}
- {"action":"update_transaction","transaction_id":"UUID","fields_to_update":{"account":"wave","amount":N}}
- {"action":"add_account","new_name":"orange_money","balance":0}
- {"action":"update_account","old_name":"cash","new_name":"liquide"}
- {"action":"query","type":"total|forecast|best_days","message":""}
- {"action":"clarify","message":"Voulez-vous :\\n1️⃣ ...\\n2️⃣ ..."}
- {"action":"answer","message":"..."}`;

        const dsRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'system', content: systemPrompt }, ...historyMessages, { role: 'user', content: message }],
                temperature: 0.1,
                max_tokens: 800
            })
        });

        const dsData = await dsRes.json();
        if (!dsData.choices?.[0]?.message?.content) {
            console.error('DeepSeek error:', JSON.stringify(dsData));
            return res.status(200).json({ action: 'answer', message: '❌ IA temporairement indisponible.' });
        }

        const raw = dsData.choices[0].message.content;

        // Extraire JSON — tableau ou objet
        const jsonMatch = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        let instruction;
        try {
            instruction = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw };
        } catch (e) {
            instruction = { action: 'answer', message: raw };
        }

        // Sauvegarder historique
        const summaryMsg = Array.isArray(instruction)
            ? `${instruction.length} actions exécutées`
            : (instruction.message || instruction.action || JSON.stringify(instruction));
        await supabasePost('chat_history', { user_id: userId, role: 'user', content: message, action: null, metadata: { periode } });
        await supabasePost('chat_history', { user_id: userId, role: 'assistant', content: summaryMsg, action: Array.isArray(instruction) ? 'multi' : instruction.action, metadata: instruction });

        return res.status(200).json(instruction);

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ action: 'answer', message: '❌ Erreur serveur. Réessayez.' });
    }
}
