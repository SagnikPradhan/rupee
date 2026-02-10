use clap::Parser;
use std::path::PathBuf;

mod file_parser;
mod parsers;

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
    let content = file_parser::parse(&args.file, args.file_type);
    let data = parsers::parse_statement(args.template, args.from, args.to, content);

    println!("{:?}", data)
}
