use std::path::PathBuf;

use anyhow::{Ok, Result};
use postgresql_embedded::{PostgreSQL, Settings, VersionReq};

pub async fn start_embedded_postgres() -> Result<String> {
    let data_dir = PathBuf::from("./.data");
    let settings = Settings {
        version: VersionReq::parse("=16.4.0")?,
        username: "postgres".to_string(),
        password: "postgres".to_string(),
        data_dir,
        ..Default::default()
    };

    let mut postgresql = PostgreSQL::new(settings);
    postgresql.setup().await?;
    postgresql.start().await?;

    let database_name = "rupee";
    postgresql.create_database(database_name).await?;
    postgresql.database_exists(database_name).await?;

    Ok(postgresql.settings().url(database_name))
}
