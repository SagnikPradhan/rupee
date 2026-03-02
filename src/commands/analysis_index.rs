use anyhow::{Context, Ok, Result, anyhow, bail};
use chrono::{Datelike, NaiveDate};
use futures::stream::{self};
use futures::{StreamExt, TryStreamExt};
use reqwest_middleware::ClientWithMiddleware;
use std::time::Duration;
use tokio::time;

use crate::data_sources::{
    nse_bhav::{Bhavcopy, get_bhavcopy},
    shared::get_request_client,
};

#[derive(clap::Args, Debug)]
pub struct AnalysisIndexArgs {}

pub async fn handler(_: AnalysisIndexArgs) -> Result<()> {
    let results = load_monthly_snapshots(2024, 2025).await?;
    print!("{:?}", results);
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

pub async fn load_monthly_snapshots(start_year: i32, end_year: i32) -> Result<Vec<Bhavcopy>> {
    let client = get_request_client(Some(Duration::from_hours(72)));
    let months = (start_year..=end_year).flat_map(|y| (1..=12).map(move |m| (y, m)));
    let result = stream::iter(months)
        .map(|(year, month)| {
            let client = client.clone();
            async move {
                time::sleep(Duration::from_millis(500)).await;
                let result = get_month_end_snapshot(&client, year, month).await;
                result
            }
        })
        .buffer_unordered(4)
        .try_collect::<Vec<_>>()
        .await?;

    Ok(result)
}
