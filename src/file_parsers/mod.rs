use std::path::Path;

pub fn parse(path: &Path, user_file_type: Option<String>) -> anyhow::Result<Vec<Vec<String>>> {
    let file_type = user_file_type
        .or_else(|| path.extension().and_then(|ext| ext.to_str()).map(|s| s.to_string()))
        .unwrap_or_default()
        .to_lowercase();

    match file_type.as_str() {
        "csv" => parse_csv(path),
        "xls" | "xlsx" => parse_xls(path),
        _ => anyhow::bail!("Unsupported file type: {}", file_type),
    }
}

fn parse_csv(path: &Path) -> anyhow::Result<Vec<Vec<String>>> {
    let mut reader = csv::Reader::from_path(path)?;

    let rows = reader
        .records()
        .map(|row| {
            let row = row?;
            Ok(row.iter().map(|c| c.trim().to_string()).collect())
        })
        .collect::<Result<Vec<Vec<String>>, csv::Error>>()?;

    Ok(rows)
}

fn parse_xls(path: &Path) -> anyhow::Result<Vec<Vec<String>>> {
    use calamine::{open_workbook_auto, Reader};

    let mut workbook = open_workbook_auto(path)?;
    let range =
        workbook.worksheet_range_at(0).ok_or_else(|| anyhow::anyhow!("No sheets found"))??;

    let rows = range
        .rows()
        .map(|row| row.iter().map(|cell| cell.to_string().trim().to_string()).collect())
        .collect();

    Ok(rows)
}
