use crate::data_sources::nse_bhav::{Bhavcopy, get_bhavcopy};
use crate::data_sources::shared::get_request_client;
use crate::database::helpers::create_price_listings;
use crate::database::models::PriceListing;
use anyhow::{Context, Result, anyhow};
use chrono::{Datelike, NaiveDate, Weekday};
use clap::Args;
use diesel::PgConnection;
use futures::{StreamExt, TryStreamExt, stream};
use rusty_money::{Money, iso};
use std::time::Duration;
use tokio::time;
use uuid::Uuid;

#[derive(Args, Debug)]
pub struct AnalysisPrepareArgs {
    /// Start date (YYYY-MM-DD)
    #[clap(long)]
    pub start: Option<NaiveDate>,
    /// End date (YYYY-MM-DD)
    #[clap(long)]
    pub end: Option<NaiveDate>,
}

pub async fn handler(args: AnalysisPrepareArgs, conn: &mut PgConnection) -> Result<()> {
    println!("Preparing analysis data");

    let start = args.start.unwrap_or_else(|| NaiveDate::from_ymd_opt(2024, 1, 1).unwrap());
    let end = args.end.unwrap_or_else(|| chrono::Utc::now().date_naive());
    load_daily_snapshots_into_db(conn, start, end).await?;

    println!("Preparation complete.");
    Ok(())
}

fn next_trading_day(date: NaiveDate) -> Result<NaiveDate> {
    let mut next = date.succ_opt().ok_or_else(|| anyhow!("Date overflow"))?;

    if next.weekday() == Weekday::Sun {
        next = next.succ_opt().ok_or_else(|| anyhow!("Date overflow"))?;
    }

    Ok(next)
}

fn trading_days(start: NaiveDate, end: NaiveDate) -> impl Iterator<Item = NaiveDate> {
    std::iter::successors(Some(start), |d| next_trading_day(*d).ok()).take_while(move |d| *d <= end)
}

fn bhav_to_listings(bhav: Bhavcopy) -> Vec<PriceListing> {
    bhav.records
        .into_iter()
        .filter_map(|stock| match Money::from_str(&stock.close, iso::INR) {
            Ok(money) => Some(PriceListing {
                id: Uuid::now_v7(),
                date: bhav.date,
                isin: stock.isin,
                ticker: stock.ticker,
                source: crate::database::models::PriceSource::Nse,
                amount: money.to_minor_units(),
            }),
            Err(e) => {
                eprintln!("price parse failed: {} ({})", stock.close, e);
                None
            }
        })
        .collect()
}

pub async fn load_daily_snapshots_into_db(
    conn: &mut PgConnection,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<()> {
    let client = get_request_client(Some(Duration::from_hours(72)));

    let mut rows_total = 0;
    let mut days_processed = 0;

    let mut stream = stream::iter(trading_days(start, end))
        .map(|date| {
            let client = client.clone();
            async move {
                time::sleep(Duration::from_millis(750)).await;
                let bhav = get_bhavcopy(&client, date)
                    .await
                    .with_context(|| format!("Failed to fetch bhavcopy for {date}"))?;
                Ok::<_, anyhow::Error>((date, bhav))
            }
        })
        .buffer_unordered(3);

    while let Some((date, bhav)) = stream.try_next().await? {
        if let Some(bhav) = bhav {
            let listings = bhav_to_listings(bhav);
            let inserted = create_price_listings(conn, &listings);
            days_processed += 1;
            rows_total += inserted;
            println!("[{}] inserted {}", date, inserted);
        }
    }

    println!("Processed {} days ({} listings total)", days_processed, rows_total);
    Ok(())
}
