use chrono::NaiveDate;
use diesel::{RunQueryDsl, SelectableHelper, SqliteConnection};
use uuid::Uuid;

use crate::database::models::{NewTransaction, Transaction};

pub fn create_transaction(
    conn: &mut SqliteConnection,
    date: &NaiveDate,
    description: &str,
    amount: &i64,
    source: &str,
    destination: &str,
) -> Transaction {
    use crate::database::schema::transaction;

    let id = Uuid::now_v7().to_string();
    let new_transaction = NewTransaction {
        id: &id,
        date: &date.to_epoch_days(),
        description,
        amount,
        source,
        destination,
    };

    diesel::insert_into(transaction::table)
        .values(&new_transaction)
        .on_conflict((transaction::date, transaction::description, transaction::amount))
        .do_nothing()
        .returning(Transaction::as_returning())
        .get_result(conn)
        .expect("Error saving transaction")
}
