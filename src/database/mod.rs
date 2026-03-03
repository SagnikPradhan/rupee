pub mod embedded;
pub mod helpers;
pub mod models;
pub mod schema;

use anyhow::{Context, Result};
use diesel::prelude::*;
use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};
use dotenvy::dotenv;
use std::env;
use tracing::info;

use crate::database::embedded::start_embedded_postgres;

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("./migrations/");

pub async fn establish_connection() -> Result<PgConnection> {
    dotenv().ok();

    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => start_embedded_postgres().await.context("Failed to start embedded Postgres")?,
    };

    // Avoid printing credentials if present
    let log_url = database_host_port(&database_url);
    info!("Using database at {}", log_url);

    let mut connection = PgConnection::establish(&database_url)
        .with_context(|| format!("Could not connect to database at {}", log_url))?;

    // Run migrations
    connection.run_pending_migrations(MIGRATIONS).map_err(|e| anyhow::anyhow!(e))?;
    info!("Database ready");

    Ok(connection)
}

fn database_host_port(url: &str) -> String {
    url.split('@').nth(1).unwrap_or(url).split('/').next().unwrap_or("unknown").to_string()
}
