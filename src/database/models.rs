use crate::database::schema::price_listing;
use crate::database::schema::transactions;
use chrono::NaiveDate;
use diesel::prelude::*;
use uuid::Uuid;

#[derive(Queryable, Selectable, Insertable)]
#[diesel(table_name = transactions)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct Transaction {
    pub id: Uuid,
    pub date: NaiveDate,
    pub description: String,
    pub amount: i64,
    pub source: String,
    pub destination: String,
}

#[derive(diesel_derive_enum::DbEnum, Debug)]
#[ExistingTypePath = "crate::database::schema::sql_types::PriceSource"]
pub enum PriceSource {
    Nse,
    Mfapi,
}

#[derive(Queryable, Selectable, Insertable)]
#[diesel(table_name = price_listing)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct PriceListing {
    pub id: Uuid,
    pub date: NaiveDate,
    pub isin: String,
    pub ticker: String,
    pub source: PriceSource,
    pub amount: i64,
}
