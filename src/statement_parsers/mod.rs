use chrono::NaiveDate;

use crate::statement_parsers::hdfc_account_statement::get_hdfc_acc_statement_parser;

mod hdfc_account_statement;

pub struct UnparsedRow {
    cells: Vec<String>,
}

#[derive(Debug)]
pub struct ParsedRow {
    pub date: NaiveDate,
    pub source: String,
    pub destination: String,
    pub description: String,
    pub amount: i32,
}

pub struct StatementParser {
    name: &'static str,
    parser: fn(
        default_from: Option<&String>,
        default_to: Option<&String>,
        row: UnparsedRow,
    ) -> Option<ParsedRow>,
}

pub fn parse_statement(
    name: String,
    default_from: Option<String>,
    default_to: Option<String>,
    data: Vec<Vec<String>>,
) -> Vec<ParsedRow> {
    let parser = get_statement_parser(name);

    map_unparsed_row(data)
        .into_iter()
        .filter_map(|row| (parser.parser)(default_from.as_ref(), default_to.as_ref(), row))
        .collect()
}

pub fn map_unparsed_row(row: Vec<Vec<String>>) -> Vec<UnparsedRow> {
    row.into_iter()
        .map(|row| UnparsedRow { cells: row })
        .collect()
}

fn get_statement_parser(name: String) -> StatementParser {
    vec![get_hdfc_acc_statement_parser()]
        .into_iter()
        .find(|v| v.name == name.as_str())
        .expect("Could not find matching parser")
}
