import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        },
        global: {
            headers: {
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
            }
        }
    }
);
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message, userId, periode } = req.body;

    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({ error: 'Missing DeepSeek API key' });
    }

    try {
        // 1. Récupérer les comptes et soldes actuels
        const { data: accounts, error: accErr } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId);
        if (accErr) throw accErr;

        // 2. Récupérer les catégories disponibles
        const { data: categories, error: catErr } = await supabase
            .from('categories')
            .select('*')
            .eq('user_id', userId);
        if (catErr) throw catErr;

        // 3. Récupérer les 5 dernières transactions
        const { data: recentTransactions, error: transErr } = await supabase
            .from('transactions')
            .select('*, categories(name, icon), accounts(name)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(5);
        if (transErr) throw transErr;

        // 4. Récupérer l'historique des 10 derniers messages
        const { data: chatHistory, error: histErr } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);
        if (histErr) throw histErr;

        // Inverser pour avoir l'ordre chronologique
        const historyMessages = (chatHistory || [])
            .reverse()
            .map(h => ({ role: h.role, content: h.content }));

        // Construire le contexte
        const accountsContext = accounts.map(a => `${a.name}: ${a.balance} F`).join(', ');
        const categoriesContext = categories.map(c => `${c.icon} ${c.name}`).join(', ');
        const transactionsContext = recentTransactions.map(t => {
            const cat = t.categories?.name || 'Sans catégorie';
            const acc = t.accounts?.name || '?';
            return `[ID:${t.id}] ${t.date} | ${t.type} | ${t.amount}F | ${cat} | ${acc} | ${t.description || ''}`;
        }).join('\n');

        const systemPrompt = `Tu es un assistant financier intelligent pour un utilisateur africain (FCFA).

CONTEXTE ACTUEL:
- Période: ${periode?.debut || 'non définie'} au ${periode?.fin || 'non définie'}
- Comptes et soldes: ${accountsContext}
- Catégories disponibles: ${categoriesContext}

5 DERNIÈRES TRANSACTIONS:
${transactionsContext || 'Aucune transaction récente'}

RÈGLES:
1. Dépenses: "sandwich 1000F cash" → action add_expense
2. Revenus: "salaire 500000F wave" → action add_income  
3. Transfert épargne: "épargne 5000F" → action add_to_savings (source par défaut: cash)
4. Requête total: "combien ce mois" → action query, type total
5. Prévision: "prévision" → action query, type forecast
6. Meilleurs jours: "meilleurs jours" → action query, type best_days
7. Suppression: "supprime la dernière" ou "supprime [ID]" → action delete_transaction
8. Modification: "modifie [ID] en 1500F" ou "c'était pas cash c'était wave" → action update_transaction
9. Ajout compte: "nouveau compte orange_money" → action add_account
10. Modif compte: "renomme cash en liquide" → action update_account
11. Si ambigu: action clarify avec une question précise

INSTRUCTIONS CRITIQUES:
- Pour delete_transaction: utilise l'ID exact de la transaction (référence les dernières transactions ci-dessus)
- Pour update_transaction: utilise l'ID exact, précise UNIQUEMENT les champs à modifier
- Pour add_account: nom en minuscules sans espaces, balance optionnelle (défaut 0)
- Si l'utilisateur dit "non c'était par wave" après une add_expense → c'est un update_transaction sur la dernière transaction créée
- Si l'utilisateur dit "annule" ou "supprime" → c'est un delete_transaction sur la dernière transaction

FORMAT DE RÉPONSE JSON STRICT:
{
  "action": "add_expense|add_income|add_to_savings|delete_transaction|update_transaction|add_account|update_account|query|clarify|answer",
  "amount": 1000,
  "description": "sandwich",
  "category": "Restaurant",
  "account": "cash",
  "date": "2026-04-25",
  "transaction_id": "uuid-xxx", // pour delete/update
  "source": "cash", // pour add_to_savings
  "new_name": "orange_money", // pour add_account
  "old_name": "cash", // pour update_account
  "type": "total|forecast|best_days", // pour query
  "message": "...", // pour answer, clarify, query
  "fields_to_update": {"amount": 1500, "account": "wave"} // pour update_transaction
}

Ne pose pas de questions inutiles. Devine quand possible. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après.`;

        // Appeler DeepSeek
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...historyMessages,
                    { role: 'user', content: message }
                ],
                temperature: 0.2
            })
        });

        const data = await response.json();
        const raw = data.choices[0].message.content;

        // Extraire le JSON
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        let instruction;
        try {
            instruction = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'answer', message: raw };
        } catch (e) {
            instruction = { action: 'answer', message: raw };
        }

        // Sauvegarder le message utilisateur dans l'historique
        await supabase.from('chat_history').insert({
            user_id: userId,
            role: 'user',
            content: message,
            action: null,
            metadata: { periode }
        });

        // Sauvegarder la réponse de l'assistant
        await supabase.from('chat_history').insert({
            user_id: userId,
            role: 'assistant',
            content: instruction.message || JSON.stringify(instruction),
            action: instruction.action,
            metadata: instruction
        });

        res.status(200).json(instruction);

    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ action: 'answer', message: 'Erreur serveur, veuillez réessayer.' });
    }
}
