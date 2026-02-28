use crate::database::schema::transaction;
use diesel::prelude::*;

#[derive(Queryable, Selectable)]
#[diesel(table_name = transaction)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Transaction {
    pub id: String,
    pub date: i32,
    pub description: String,
    pub amount: i64,
    pub source: String,
    pub destination: String,
}

#[derive(Insertable)]
#[diesel(table_name = transaction)]
pub struct NewTransaction<'a> {
    pub id: &'a str,
    pub date: &'a i32,
    pub description: &'a str,
    pub amount: &'a i64,
    pub source: &'a str,
    pub destination: &'a str,
}
