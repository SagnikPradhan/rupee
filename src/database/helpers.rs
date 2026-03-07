use diesel::{ExpressionMethods, PgConnection, RunQueryDsl, SelectableHelper, upsert};

use crate::database::models::{PriceListing, Transaction};
use crate::database::schema::{price_listing, transactions};

pub fn create_transaction(conn: &mut PgConnection, transaction: Transaction) -> Transaction {
    diesel::insert_into(transactions::table)
        .values(&transaction)
        .on_conflict((transactions::date, transactions::description, transactions::amount))
        .do_nothing()
        .returning(Transaction::as_returning())
        .get_result(conn)
        .expect("Error saving transaction")
}

pub fn create_price_listings(conn: &mut PgConnection, listings: &[PriceListing]) -> usize {
    diesel::insert_into(price_listing::table)
        .values(listings)
        .on_conflict((price_listing::ticker, price_listing::date))
        .do_update()
        .set(price_listing::amount.eq(upsert::excluded(price_listing::amount)))
        .execute(conn)
        .expect("Error inserting price listings")
}
