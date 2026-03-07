use anyhow::Result;
use diesel::PgConnection;

#[derive(clap::Args, Debug)]
pub struct AnalysisIndexArgs {}

pub async fn handler(_: AnalysisIndexArgs, _: &mut PgConnection) -> Result<()> {
    Ok(())
}
