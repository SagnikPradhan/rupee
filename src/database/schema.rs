// @generated automatically by Diesel CLI.

diesel::table! {
    transaction (id) {
        id -> Text,
        date -> Date,
        description -> Text,
        amount -> Integer,
        source -> Text,
        destination -> Text,
    }
}
