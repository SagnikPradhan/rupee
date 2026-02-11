use crate::database::schema::transaction;
use chrono::NaiveDate;
use diesel::prelude::*;

#[derive(Queryable, Selectable)]
#[diesel(table_name = transaction)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Transaction {
    pub id: String,
    pub date: NaiveDate,
    pub description: String,
    pub amount: i32,
    pub source: String,
    pub destination: String,
}

#[derive(Insertable)]
#[diesel(table_name = transaction)]
pub struct NewTransaction<'a> {
    pub id: &'a str,
    pub date: &'a NaiveDate,
    pub description: &'a str,
    pub amount: &'a i32,
    pub source: &'a str,
    pub destination: &'a str,
}
