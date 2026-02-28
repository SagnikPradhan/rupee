use clap::Parser;

mod commands;
mod data_sources;
mod database;
mod file_parsers;
mod statement_parsers;

#[derive(clap::Parser, Debug)]
#[command(version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(clap::Subcommand, Debug)]
enum Commands {
    /// Parse and ingest a statement
    Parse(commands::parse::ParseArgs),
    /// Get rolling returns of a fund
    Rolling(commands::rolling::RollingArgs),
}

fn main() -> anyhow::Result<()> {
    let args = Cli::parse();
    let mut connection = database::establish_connection();

    match args.command {
        Commands::Parse(args) => commands::parse::handler(args, &mut connection)?,
        Commands::Rolling(args) => commands::rolling::handler(args)?,
    }

    Ok(())
}
