use chrono::NaiveDate;

mod hdfc_account_statement;

use self::hdfc_account_statement::HDFC_ACCOUNT_PARSER;

/// All available parsers
static PARSERS: &[StatementParser] = &[HDFC_ACCOUNT_PARSER];

/// Raw CSV row before parsing
#[derive(Debug)]
pub struct UnparsedRow {
    pub cells: Vec<String>,
}

/// Normalized row after parsing
#[derive(Debug)]
pub struct ParsedRow {
    pub date: NaiveDate,
    pub source: String,
    pub destination: String,
    pub description: String,
    pub amount: i64, // minor units
}

/// Parser definition
pub struct StatementParser {
    pub name: &'static str,
    pub parser: fn(
        default_from: Option<&String>,
        default_to: Option<&String>,
        row: &UnparsedRow,
    ) -> anyhow::Result<ParsedRow>,
}

/// Public entry point
pub fn parse_statement(
    name: &str,
    default_from: Option<&String>,
    default_to: Option<&String>,
    data: Vec<Vec<String>>,
) -> anyhow::Result<Vec<ParsedRow>> {
    let parser = get_statement_parser(name);

    anyhow::Ok(
        data.into_iter()
            .filter_map(|cells| {
                let row = UnparsedRow { cells };
                match (parser.parser)(default_from, default_to, &row) {
                    Ok(p) => Some(p),
                    Err(e) => {
                        eprintln!("Skipping row: {}", e);
                        None
                    }
                }
            })
            .collect(),
    )
}

/// Get statement parser
fn get_statement_parser(name: &str) -> &'static StatementParser {
    PARSERS.iter().find(|p| p.name == name).expect("Could not find matching parser")
}
