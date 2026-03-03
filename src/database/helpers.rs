use chrono::NaiveDate;
use diesel::{PgConnection, RunQueryDsl, SelectableHelper};
use uuid::Uuid;

use crate::database::models::{NewTransaction, Transaction};
use crate::database::schema::transactions;

pub fn create_transaction(
    conn: &mut PgConnection,
    date: &NaiveDate,
    description: &str,
    amount: &i64,
    source: &str,
    destination: &str,
) -> Transaction {
    let new_transaction = NewTransaction {
        id: &Uuid::now_v7(),
        date: &date,
        description,
        amount,
        source,
        destination,
    };

    diesel::insert_into(transactions::table)
        .values(&new_transaction)
        .on_conflict((transactions::date, transactions::description, transactions::amount))
        .do_nothing()
        .returning(Transaction::as_returning())
        .get_result(conn)
        .expect("Error saving transaction")
}
