-- Activer l'extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profils utilisateurs (liés à auth.users)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    default_currency TEXT DEFAULT 'FCFA',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Catégories personnalisables
CREATE TABLE categories (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📦',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- Comptes (cash, wave, epargne)
CREATE TABLE accounts (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    balance DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- Transactions (dépenses, revenus, transferts)
CREATE TABLE transactions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    description TEXT,
    category_id UUID REFERENCES categories(id),
    account_id UUID REFERENCES accounts(id),
    type TEXT CHECK (type IN ('expense', 'income', 'transfer')) DEFAULT 'expense',
    date DATE DEFAULT CURRENT_DATE,
    recurring BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Remboursements (liés à une dépense originale)
CREATE TABLE reimbursements (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    original_transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    from_person TEXT,
    date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index pour performances
CREATE INDEX idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX idx_transactions_user_account ON transactions(user_id, account_id);
CREATE INDEX idx_transactions_user_category ON transactions(user_id, category_id);

-- Activer Row Level Security (RLS)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursements ENABLE ROW LEVEL SECURITY;

-- Politiques : chaque utilisateur ne voit que ses propres données
CREATE POLICY "Users can view own profile" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "Users can manage own categories" ON categories FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own accounts" ON accounts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own transactions" ON transactions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own reimbursements" ON reimbursements FOR ALL USING (auth.uid() = user_id);

-- Fonction pour créer automatiquement un profil et les comptes par défaut à l'inscription
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, email) VALUES (NEW.id, NEW.email);
    INSERT INTO categories (user_id, name, icon) VALUES
        (NEW.id, 'Restaurant', '🍽️'),
        (NEW.id, 'Courses', '🛒'),
        (NEW.id, 'Transport', '🚗'),
        (NEW.id, 'Loisirs', '🎬'),
        (NEW.id, 'Santé', '💊'),
        (NEW.id, 'Logement', '🏠'),
        (NEW.id, 'Épargne', '💰'),
        (NEW.id, 'Autres', '📦');
    INSERT INTO accounts (user_id, name, balance) VALUES
        (NEW.id, 'cash', 0),
        (NEW.id, 'wave', 0),
        (NEW.id, 'epargne', 0);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger après inscription
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();
