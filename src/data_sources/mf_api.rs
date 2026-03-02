use anyhow::{Error, Result};
use chrono::NaiveDate;
use rusty_money::{Money, iso};
use serde::{Deserialize, Serialize};

use crate::data_sources::shared::get_request_client;

#[derive(Serialize, Deserialize, Debug)]
pub struct MFAPIResult {
    meta: MFAPIMeta,
    data: Vec<MFAPIListing>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MFAPIMeta {
    fund_house: String,
    scheme_name: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MFAPIListing {
    date: String,
    nav: String,
}

pub struct FundDetails {
    pub fund_house: String,
    pub scheme_name: String,
    pub prices: Vec<PricePoint>,
}

pub struct PricePoint {
    pub date: NaiveDate,
    pub amount: i64,
}

pub async fn get_fund_details(fund: &str) -> Result<FundDetails> {
    let result = fetch_mfapi(fund).await?;
    let mut prices = result
        .data
        .into_iter()
        .map(|nav| {
            let date = NaiveDate::parse_from_str(&nav.date, "%d-%m-%Y")?;
            let amount = Money::from_str(&nav.nav, iso::INR)?.to_minor_units();
            Ok(PricePoint { date, amount })
        })
        .collect::<Result<Vec<_>, Error>>()?;

    prices.sort_by_key(|p| p.date);
    prices.dedup_by_key(|p| p.date);

    Ok(FundDetails {
        fund_house: result.meta.fund_house,
        scheme_name: result.meta.scheme_name,
        prices,
    })
}

async fn fetch_mfapi(fund: &str) -> Result<MFAPIResult> {
    let client = get_request_client(None);
    let url = format!("https://api.mfapi.in/mf/{}", fund);
    let result = client.get(&url).send().await?.json::<MFAPIResult>().await?;
    Ok(result)
}
