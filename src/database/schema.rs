// @generated automatically by Diesel CLI.

diesel::table! {
    price_listing (id) {
        id -> Uuid,
        date -> Date,
        isin -> Text,
        ticker -> Text,
        amount -> Int8,
    }
}

diesel::table! {
    transactions (id) {
        id -> Uuid,
        date -> Date,
        description -> Text,
        amount -> Int8,
        source -> Text,
        destination -> Text,
    }
}

diesel::allow_tables_to_appear_in_same_query!(price_listing, transactions,);
