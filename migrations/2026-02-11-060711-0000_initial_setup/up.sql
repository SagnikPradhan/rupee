-- Enable UUID generation if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE transactions (
    id UUID PRIMARY KEY,
    date DATE NOT NULL,
    description TEXT NOT NULL,
    amount BIGINT NOT NULL,
    source TEXT NOT NULL,
    destination TEXT NOT NULL,

    CONSTRAINT unique_transaction
        UNIQUE (date, description, amount, source, destination)
);

CREATE TABLE price_listing (
    id UUID PRIMARY KEY,
    date DATE NOT NULL,
    isin TEXT NOT NULL,
    ticker TEXT NOT NULL,
    amount BIGINT NOT NULL,

    CONSTRAINT unique_price_listing
        UNIQUE (ticker, date)
);

-- Helpful indexes
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_price_listing_date ON price_listing(date);
CREATE INDEX idx_price_listing_isin ON price_listing(isin);
CREATE INDEX idx_price_listing_ticker ON price_listing(ticker);
