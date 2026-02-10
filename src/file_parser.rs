use std::path::PathBuf;

pub fn parse(path: &PathBuf, user_file_type: Option<String>) -> Vec<Vec<String>> {
    let file_extension = path
        .extension()
        .map(|ext| ext.to_str().unwrap().to_string())
        .unwrap_or_default();

    let file_type = user_file_type.unwrap_or(file_extension).to_lowercase();

    match file_type.as_str() {
        "csv" => return parse_csv(path),
        "xls" => return parse_xls(path),
        _ => panic!("File is not supported"),
    }
}

fn parse_csv(path: &PathBuf) -> Vec<Vec<String>> {
    use csv::Reader;

    Reader::from_path(path)
        .expect("Cannot open file")
        .into_records()
        .map(|row| {
            row.expect("Cannot read row")
                .into_iter()
                .map(|cell| String::from(cell.trim()))
                .collect()
        })
        .collect()
}

fn parse_xls(path: &PathBuf) -> Vec<Vec<String>> {
    use calamine::{DataType, Reader, open_workbook_auto};

    let mut book = open_workbook_auto(&path).expect("Cannot parse file");
    let first_sheet = book.worksheet_range_at(0).unwrap().unwrap();
    let rows = first_sheet.rows().map(|row| {
        row.iter()
            .map(|cell| cell.as_string().unwrap_or_default().trim().to_string())
            .collect()
    });

    rows.collect()
}
