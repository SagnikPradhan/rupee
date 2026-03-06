use std::fs;

use anyhow::{Context, Result, ensure};
use chrono::NaiveDate;
use reqwest_middleware::ClientWithMiddleware;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug)]
pub struct Bhavcopy {
    pub date: NaiveDate,
    pub records: Vec<BhavRecord>,
}

#[derive(Debug, Deserialize)]
pub struct BhavRecord {
    #[serde(rename = "SctySrs")]
    pub series: String,
    #[serde(rename = "ISIN")]
    pub isin: String,
    #[serde(rename = "TckrSymb")]
    pub ticker: String,
    #[serde(rename = "ClsPric")]
    pub close: String,
}

pub async fn get_bhavcopy(
    client: &ClientWithMiddleware,
    date: NaiveDate,
) -> Result<Option<Bhavcopy>> {
    println!("Fetching bhavcopy {}", date);
    let data = request_bhavcopy(client, date).await?;
    if data.is_none() {
        println!("No bhavcopy available for {}", date);
        return Ok(None);
    }

    let csv = unzip_file(&data.unwrap())?;
    let csv_path = format!("data/bhav/{}.csv", date);
    fs::create_dir_all("data/bhav")?;
    fs::write(&csv_path, &csv)?;
    println!("Saved csv to {}", csv_path);

    let records = parse_csv(&csv)?;
    println!("Parsed {} records for {}", records.len(), date);

    Ok(Some(Bhavcopy { date, records }))
}

async fn request_bhavcopy(
    client: &ClientWithMiddleware,
    date: NaiveDate,
) -> Result<Option<Vec<u8>>> {
    let url = nse_reports_url(date);
    let response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("Failed to fetch bhavcopy for {}", date))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let response = response
        .error_for_status()
        .with_context(|| format!("NSE returned an error status for {}", date))?;

    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("Failed to read bhavcopy body for {}", date))?;

    Ok(Some(bytes.to_vec()))
}

fn nse_reports_url(date: NaiveDate) -> String {
    let file = json!([{
        "name": "CM-UDiFF Common Bhavcopy Final (zip)",
        "type": "daily-reports",
        "category": "capital-market",
        "section": "equities"
    }]);

    format!(
        "https://www.nseindia.com/api/reports?archives={}&date={}&type=equities&mode=single",
        file.to_string(),
        date.format("%d-%b-%Y").to_string()
    )
}

fn unzip_file(zip_bytes: &[u8]) -> Result<Vec<u8>> {
    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    let reader = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader)?;

    ensure!(archive.len() > 0, "Empty zip archive");

    let mut file = archive.by_index(0)?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;

    Ok(contents)
}

fn parse_csv(bytes: &[u8]) -> Result<Vec<BhavRecord>> {
    let mut records = Vec::new();
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(true)
        .trim(csv::Trim::All)
        .from_reader(bytes);

    let headers = rdr.headers()?.iter().take_while(|v| !v.is_empty()).collect();
    rdr.set_headers(headers);

    for result in rdr.deserialize::<BhavRecord>() {
        if let Ok(record) = result {
            if record.series == "EQ" {
                records.push(record);
            }
        }
    }

    Ok(records)
}
