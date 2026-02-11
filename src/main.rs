use clap::Parser;
use std::path::PathBuf;

use crate::database::{establish_connection, helpers::create_transaction};

mod database;
mod file_parsers;
mod statement_parsers;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Args {
    /// Template used to parse the input file
    #[arg(short = 'p')]
    template: String,

    /// Path to the input file
    file: PathBuf,

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

fn main() {
    let args = Args::parse();
    let content = file_parsers::parse(&args.file, args.file_type);
    let data = statement_parsers::parse_statement(args.template, args.from, args.to, content);

    let mut connection = establish_connection();
    data.iter().for_each(|row| {
        create_transaction(
            &mut connection,
            &row.date,
            &row.description,
            &row.amount,
            &row.source,
            &row.destination,
        );
    });

    println!("{:?}", data)
}
