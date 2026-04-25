export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { message, userId, periode, categories, accounts } = req.body;

    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) return res.status(500).json({ error: 'Missing API key' });

    const context = `
        Contexte utilisateur:
        - Période actuelle: ${periode.debut} au ${periode.fin}
        - Catégories disponibles: ${categories.map(c => c.name).join(', ')}
        - Comptes disponibles: cash, wave, epargne
        Règles:
        - Dépenses: "sandwich 1000F cash" → action add_expense, catégorie à déduire (sandwich=Restaurant)
        - "épargne 5000F" → action add_to_savings, source par défaut cash
        - "combien ce mois" → action query, type total
        - "prévision" → action query, type forecast
        - "meilleurs jours" → action query, type best_days
        Réponds TOUJOURS en JSON strict avec action et paramètres.
    `;

    const systemPrompt = `Tu es un assistant financier rapide. ${context}
    Format de réponse JSON:
    - Pour ajout dépense: {"action":"add_expense","amount":1000,"description":"sandwich","category":"Restaurant","account":"cash","date":"YYYY-MM-DD"}
    - Pour épargne: {"action":"add_to_savings","amount":5000,"source":"cash"}
    - Pour requête total: {"action":"query","type":"total","message":"..."}
    - Pour prévision: {"action":"query","type":"forecast"}
    - Pour meilleurs jours: {"action":"query","type":"best_days"}
    - Pour réponse texte simple: {"action":"answer","message":"..."}
    Ne pose pas de questions. Devine la catégorie si possible. Réponds UNIQUEMENT en JSON, sans texte avant ou après.`;

    try {
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
                    { role: 'user', content: message }
                ],
                temperature: 0.2
            })
        });

        const data = await response.json();
        const raw = data.choices[0].message.content;

        // Extraire le JSON de la réponse
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const instruction = jsonMatch
            ? JSON.parse(jsonMatch[0])
            : { action: 'answer', message: raw };

        res.status(200).json(instruction);
    } catch (err) {
        console.error('DeepSeek error:', err);
        res.status(500).json({ action: 'answer', message: 'Erreur IA, veuillez réessayer.' });
    }
}
