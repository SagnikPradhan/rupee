// @generated automatically by Diesel CLI.

diesel::table! {
    transaction (id) {
        id -> Text,
        date -> Integer,
        description -> Text,
        amount -> BigInt,
        source -> Text,
        destination -> Text,
    }
}
