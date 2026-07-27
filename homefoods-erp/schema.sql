-- 1. Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    mobile TEXT,
    geo_point TEXT, 
    preference TEXT CHECK (preference IN ('veg', 'non-veg')) DEFAULT 'veg',
    meal_plan TEXT[] DEFAULT ARRAY['lunch', 'dinner'], 
    start_date DATE DEFAULT CURRENT_DATE,
    end_date DATE,
    credit_balance NUMERIC DEFAULT 0.00,
    is_archived boolean default false,
);

-- 2. Global Pricing Settings
CREATE TABLE global_settings (
    id SERIAL PRIMARY KEY,
    base_breakfast NUMERIC DEFAULT 40.00,
    base_lunch NUMERIC DEFAULT 85.00,
    base_dinner NUMERIC DEFAULT 40.00,
    nv_premium NUMERIC DEFAULT 25.00
);

-- 3. Daily Roster
CREATE TABLE daily_roster (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    roster_date DATE NOT NULL,
    b_status TEXT DEFAULT 'skipped', -- 'active' | 'skipped'
    l_status TEXT DEFAULT 'active',  -- 'active' | 'skipped' | 'nv_downgraded'
    d_status TEXT DEFAULT 'active',
    UNIQUE(customer_id, roster_date)
);

-- 4. Transactions Ledger
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    amount NUMERIC NOT NULL,
    upi_id TEXT
);