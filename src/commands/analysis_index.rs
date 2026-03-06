use anyhow::Result;

#[derive(clap::Args, Debug)]
pub struct AnalysisIndexArgs {}

pub async fn handler(_: AnalysisIndexArgs) -> Result<()> {
    Ok(())
}
