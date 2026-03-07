// @generated automatically by Diesel CLI.

pub mod sql_types {
    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "price_source"))]
    pub struct PriceSource;
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::PriceSource;

    price_listing (id) {
        id -> Uuid,
        date -> Date,
        isin -> Text,
        ticker -> Text,
        source -> PriceSource,
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
