// @generated automatically by Diesel CLI.

diesel::table! {
    transactions (id) {
        id -> Uuid,
        date -> Date,
        description -> Text,
        amount -> BigInt,
        source -> Text,
        destination -> Text,
    }
}

diesel::table! {
    price_listing (id) {
        id -> Uuid,
        date -> Date,
        isin -> Text,
        ticker -> Text,
        amount -> BigInt,
    }
}
