use crate::statement_parsers::{ParsedRow, UnparsedRow};
use anyhow::{bail, Result};
use chrono::NaiveDate;
use rusty_money::{iso, Money};

pub const HDFC_ACCOUNT_PARSER: super::StatementParser =
    super::StatementParser { name: "HDFC Account", parser: parse_hdfc_row };

pub fn parse_hdfc_row(
    default_from: Option<&String>,
    default_to: Option<&String>,
    row: &UnparsedRow,
) -> Result<ParsedRow> {
    let date = NaiveDate::parse_from_str(
        row.cells.get(0).ok_or_else(|| anyhow::anyhow!("Missing date"))?,
        "%d/%m/%Y",
    )?;

    let description =
        row.cells.get(1).ok_or_else(|| anyhow::anyhow!("Missing description"))?.clone();

    let source = default_from.cloned().unwrap_or_else(|| description.clone());
    let destination = default_to.cloned().unwrap_or_else(|| description.clone());

    let parse_money =
        |idx| row.cells.get(idx).and_then(|v: &String| Money::from_str(v.trim(), iso::INR).ok());

    let amount = match (parse_money(3), parse_money(4)) {
        (Some(d), None) => -d.to_minor_units(),
        (None, Some(c)) => c.to_minor_units(),
        _ => bail!("Invalid debit/credit structure"),
    };

    Ok(ParsedRow { date, source, destination, description, amount })
}
