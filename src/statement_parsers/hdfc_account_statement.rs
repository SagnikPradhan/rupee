use crate::statement_parsers::{ParsedRow, StatementParser};
use chrono::NaiveDate;

pub fn get_hdfc_acc_statement_parser() -> StatementParser {
    StatementParser {
        name: "HDFC Account",
        parser: |default_from, default_to, row| {
            let Ok(date) = NaiveDate::parse_from_str(&row.cells[0], "%d/%m/%Y") else {
                return None;
            };

            let source = default_from.cloned().unwrap_or(row.cells[1].clone());
            let destination = default_to.cloned().unwrap_or(row.cells[1].clone());
            let description = row.cells[1].clone();
            let amount = row.cells[3]
                .parse::<f32>()
                .map(|amount| 0 as f32 - (amount))
                .or(row.cells[4].parse::<f32>())
                .map(|amount| (amount * 1000.0).round() as i32)
                .unwrap();

            Some(ParsedRow {
                date,
                source,
                destination,
                amount,
                description,
            })
        },
    }
}
