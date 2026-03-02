use anyhow::{Context, Ok, Result, ensure};
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
    #[serde(rename = "ISIN")]
    pub isin: String,
    // #[serde(rename = "TckrSymb")]
    // pub symbol: String,
    #[serde(rename = "FinInstrmNm")]
    pub name: String,
    #[serde(rename = "OpnPric")]
    pub open: f64,
    // #[serde(rename = "HghPric")]
    // pub high: f64,
    // #[serde(rename = "LwPric")]
    // pub low: f64,
    #[serde(rename = "ClsPric")]
    pub close: f64,
    #[serde(rename = "TtlTrfVal")]
    pub volume: f64,
}

pub async fn get_bhavcopy(
    client: &ClientWithMiddleware,
    date: NaiveDate,
) -> Result<Option<Bhavcopy>> {
    let data = request_bhavcopy(client, date).await?;
    if data.is_none() {
        return Ok(None);
    }

    let csv = unzip_file(&data.unwrap())?;
    let records = parse_csv(&csv)?;

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
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);

    let mut records = Vec::new();
    for record in rdr.deserialize::<BhavRecord>().flatten() {
        records.push(record);
    }

    Ok(records)
}
