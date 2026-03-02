use std::{path::PathBuf, time::Duration};

use http_cache::{CACacheManager, CacheMode, HttpCache, HttpCacheOptions};
use http_cache_reqwest::Cache;
use reqwest::Client;
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};

pub fn get_request_client(default_ttl: Option<Duration>) -> ClientWithMiddleware {
    let cache_ttl = default_ttl.or(Some(Duration::from_hours(24)));
    let cache_middlware = Cache(HttpCache {
        mode: CacheMode::IgnoreRules,
        manager: CACacheManager::new(get_cache_dir(), true),
        options: HttpCacheOptions { max_ttl: cache_ttl, ..Default::default() },
    });

    ClientBuilder::new(Client::new()).with(cache_middlware).build()
}

fn get_cache_dir() -> PathBuf {
    let mut path = dirs::cache_dir().unwrap();
    path.push("rupee");
    path
}
