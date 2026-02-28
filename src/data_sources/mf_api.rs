use anyhow::{Context, Result};
use chrono::NaiveDate;
use rusty_money::{iso, Money};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

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

pub fn get_fund_details(fund: &str) -> Result<FundDetails> {
    let data = request_cached_mfapi(fund)?;
    let result: MFAPIResult = serde_json::from_str(&data)?;

    let mut prices = result
        .data
        .into_iter()
        .map(|nav| {
            let date = NaiveDate::parse_from_str(&nav.date, "%d-%m-%Y")?;
            let amount = Money::from_str(&nav.nav, iso::INR)?.to_minor_units();
            Ok(PricePoint { date, amount })
        })
        .collect::<Result<Vec<_>, anyhow::Error>>()?;

    prices.sort_by_key(|p| p.date);
    prices.dedup_by_key(|p| p.date);

    Ok(FundDetails {
        fund_house: result.meta.fund_house,
        scheme_name: result.meta.scheme_name,
        prices,
    })
}

fn create_cache_file(fund: &str) -> PathBuf {
    let mut path = dirs::cache_dir().unwrap();
    path.push("rupee");
    path.push("mfapi");
    std::fs::create_dir_all(&path).unwrap();
    path.push(format!("{}.json", fund));
    path
}

fn is_cache_fresh(path: &PathBuf) -> bool {
    if let Ok(metadata) = std::fs::metadata(path) {
        if let Ok(modified) = metadata.modified() {
            return SystemTime::now().duration_since(modified).unwrap_or(Duration::from_secs(0))
                < Duration::from_secs(60 * 60 * 2); // 2h TTL
        }
    }

    false
}

fn reqeust_mfapi(fund: &str) -> Result<String> {
    let url = format!("https://api.mfapi.in/mf/{}", fund);
    let response =
        reqwest::blocking::get(&url).with_context(|| format!("Failed to fetch {}", url))?;

    let body = response.text()?;
    Ok(body)
}

pub fn request_cached_mfapi(fund: &str) -> Result<String> {
    let path = create_cache_file(fund);
    if path.exists() && is_cache_fresh(&path) {
        return Ok(std::fs::read_to_string(path)?);
    }

    let body = reqeust_mfapi(fund)?;
    std::fs::write(&path, &body)?;
    Ok(body)
}
