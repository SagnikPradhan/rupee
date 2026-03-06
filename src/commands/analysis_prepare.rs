use anyhow::{Context, Result, anyhow, bail};
use chrono::{Datelike, NaiveDate};
use diesel::PgConnection;
use futures::{StreamExt, TryStreamExt, stream};
use reqwest_middleware::ClientWithMiddleware;
use rusty_money::{Money, iso};
use std::time::Duration;
use tokio::time;
use uuid::Uuid;

use crate::data_sources::nse_bhav::{Bhavcopy, get_bhavcopy};
use crate::data_sources::shared::get_request_client;
use crate::database::helpers::create_price_listings;
use crate::database::models::PriceListing;

#[derive(clap::Args, Debug)]
pub struct AnalysisPrepareArgs {}

pub async fn handler(_: AnalysisPrepareArgs, conn: &mut PgConnection) -> Result<()> {
    println!("Preparing analysis data");
    load_monthly_snapshots_into_db(conn, 2024, 2025).await?;
    println!("Preparation complete.");
    Ok(())
}

pub async fn get_month_end_snapshot(
    client: &ClientWithMiddleware,
    year: i32,
    month: u32,
) -> Result<Bhavcopy> {
    let mut date = last_day_of_month(year, month)?;

    while date.month() == month {
        if let Some(bhav) = get_bhavcopy(client, date)
            .await
            .with_context(|| format!("Failed to fetch bhavcopy for date {date}"))?
        {
            return Ok(bhav);
        }

        date = date.pred_opt().ok_or_else(|| anyhow!("Date underflow"))?;
    }

    bail!("Could not find month end for {year}-{month}")
}

fn last_day_of_month(year: i32, month: u32) -> Result<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month + 1, 1)
        .or(NaiveDate::from_ymd_opt(year + 1, 1, 1))
        .and_then(|date| date.pred_opt())
        .ok_or_else(|| anyhow!("Invalid date"))
}

pub async fn load_monthly_snapshots_into_db(
    conn: &mut PgConnection,
    start_year: i32,
    end_year: i32,
) -> Result<()> {
    let client = get_request_client(Some(Duration::from_hours(72)));
    let months = (start_year..=end_year).flat_map(|y| (1..=12).map(move |m| (y, m)));

    let mut stream = stream::iter(months)
        .map(|(year, month)| {
            let client = client.clone();
            async move {
                time::sleep(Duration::from_millis(500)).await;
                get_month_end_snapshot(&client, year, month).await
            }
        })
        .buffer_unordered(4);

    let mut rows_total = 0;
    let mut months_done = 0;

    while let Some(bhav) = stream.try_next().await? {
        let listings: Vec<PriceListing> = bhav
            .records
            .into_iter()
            .filter_map(|stock| match Money::from_str(&stock.close, iso::INR) {
                Ok(money) => Some(PriceListing {
                    id: Uuid::now_v7(),
                    date: bhav.date,
                    isin: stock.isin,
                    ticker: stock.ticker,
                    amount: money.to_minor_units(),
                }),
                Err(e) => {
                    eprintln!("price parse failed: {} ({})", stock.close, e);
                    None
                }
            })
            .collect();

        let inserted = create_price_listings(conn, &listings);

        months_done += 1;
        rows_total += inserted;

        println!(
            "[{:04}-{:02}] inserted {} listings",
            bhav.date.year(),
            bhav.date.month(),
            inserted
        );
    }

    println!("Processed {} months ({} listings total)", months_done, rows_total);
    Ok(())
}
