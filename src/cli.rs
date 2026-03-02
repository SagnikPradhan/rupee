use clap::{Parser, Subcommand};

use crate::commands;

// Top-level CLI
#[derive(Parser, Debug)]
#[clap(name = "pcparts")] // or whatever your binary name is
#[clap(version, about)]
pub struct Cli {
    #[clap(subcommand)]
    pub command: Commands,
}

// Second tier — domain groups
#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Personal finance & statement ingestion
    #[clap(name = "finance")]
    FinanceGroup(Finance),

    /// Market & portfolio analysis
    #[clap(name = "analysis")]
    AnalysisGroup(Analysis),
}

// Finance command group
#[derive(Parser, Debug)]
pub struct Finance {
    #[clap(subcommand)]
    pub finance_commands: FinanceCommands,
}

#[derive(Subcommand, Debug)]
pub enum FinanceCommands {
    /// Parse and ingest a statement
    Parse(commands::finance_parse::FinanceParseArgs),
}

// Analysis command group
#[derive(Parser, Debug)]
pub struct Analysis {
    #[clap(subcommand)]
    pub analysis_commands: AnalysisCommands,
}

#[derive(Subcommand, Debug)]
pub enum AnalysisCommands {
    /// Construct a market index
    Index(commands::analysis_index::AnalysisIndexArgs),
    /// Rolling returns of a fund
    Rolling(commands::analysis_rolling::AnalysisRollingArgs),
}
