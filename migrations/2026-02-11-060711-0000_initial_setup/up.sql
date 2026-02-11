CREATE TABLE "transaction" (
    id TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    source TEXT NOT NULL,
    destination TEXT NOT NULL,
    PRIMARY KEY (id)
);
