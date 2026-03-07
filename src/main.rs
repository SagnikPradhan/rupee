use clap::Parser;

use crate::cli::{AnalysisCommands, Cli, Commands, FinanceCommands};
use crate::commands::analysis_index;
use crate::commands::analysis_prepare;
use crate::commands::analysis_rolling;
use crate::commands::finance_parse;

mod cli;
mod commands;
mod data_sources;
mod database;
mod file_parsers;
mod statement_parsers;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Cli::parse();
    let mut conn = database::establish_connection().await?;

    match args.command {
        Commands::FinanceGroup(finance) => match finance.finance_commands {
            FinanceCommands::Parse(args) => finance_parse::handler(args, &mut conn)?,
        },

        Commands::AnalysisGroup(analysis) => match analysis.analysis_commands {
            AnalysisCommands::Prepare(args) => analysis_prepare::handler(args, &mut conn).await?,
            AnalysisCommands::Rolling(args) => analysis_rolling::handler(args).await?,
            AnalysisCommands::Index(args) => analysis_index::handler(args, &mut conn).await?,
        },
    }

    Ok(())
}
