use crate::database::models::Transaction;
use crate::{database, file_parsers, statement_parsers};
use anyhow::Result;
use uuid::Uuid;

#[derive(clap::Args, Debug)]
pub struct FinanceParseArgs {
    /// Template used to parse the input file
    #[arg(short = 'p')]
    template: String,

    /// Path to the input file
    file: std::path::PathBuf,

    /// Explicit file type (overrides auto-detection)
    #[arg(short = 'k')]
    file_type: Option<String>,

    /// Default source account
    #[arg(short = 's')]
    from: Option<String>,

    /// Default destination account
    #[arg(short = 'd')]
    to: Option<String>,
}

pub fn handler(args: FinanceParseArgs, connection: &mut diesel::PgConnection) -> Result<()> {
    let FinanceParseArgs { template, file, file_type, from, to } = args;
    let content = file_parsers::parse(&file, file_type)?;
    let data = statement_parsers::parse_statement(&template, from.as_ref(), to.as_ref(), content)?;

    for row in &data {
        database::helpers::create_transaction(
            connection,
            Transaction {
                id: Uuid::now_v7(),
                date: row.date,
                description: row.description.clone(),
                amount: row.amount,
                source: row.source.clone(),
                destination: row.destination.clone(),
            },
        );
    }

    Ok(())
}
