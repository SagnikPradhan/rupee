CREATE UNIQUE INDEX IF NOT EXISTS unique_transactions
    ON "transaction" (date, description, amount);
