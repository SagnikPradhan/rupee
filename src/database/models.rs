use crate::database::schema::price_listing;
use crate::database::schema::transactions;
use chrono::NaiveDate;
use diesel::prelude::*;
use uuid::Uuid;

#[derive(Queryable, Selectable)]
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

#[derive(Insertable)]
#[diesel(table_name = transactions)]
pub struct NewTransaction<'a> {
    pub id: &'a Uuid,
    pub date: &'a NaiveDate,
    pub description: &'a str,
    pub amount: &'a i64,
    pub source: &'a str,
    pub destination: &'a str,
}

#[derive(Queryable, Selectable)]
#[diesel(table_name = price_listing)]
#[diesel(check_for_backend(diesel::pg::Pg))]
pub struct PriceListing {
    pub id: Uuid,
    pub date: NaiveDate,
    pub isin: String,
    pub ticker: String,
    pub amount: i64,
}

#[derive(Insertable)]
#[diesel(table_name = price_listing)]
pub struct NewPriceListing<'a> {
    pub id: &'a Uuid,
    pub date: &'a NaiveDate,
    pub isin: &'a str,
    pub ticker: &'a str,
    pub amount: &'a i64,
}
