use clap::Parser;

use crate::cli::{AnalysisCommands, Cli, Commands, FinanceCommands};

mod cli;
mod commands;
mod data_sources;
mod database;
mod file_parsers;
mod statement_parsers;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Cli::parse();
    let mut connection = database::establish_connection().await?;

    match args.command {
        Commands::FinanceGroup(finance) => match finance.finance_commands {
            FinanceCommands::Parse(args) => {
                commands::finance_parse::handler(args, &mut connection)?
            }
        },

        Commands::AnalysisGroup(analysis) => match analysis.analysis_commands {
            AnalysisCommands::Rolling(args) => commands::analysis_rolling::handler(args).await?,
            AnalysisCommands::Index(args) => commands::analysis_index::handler(args).await?,
        },
    }

    Ok(())
}
