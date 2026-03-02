use crate::data_sources::mf_api::{PricePoint, get_fund_details};
use anyhow::{Result, ensure};
use chrono::{Duration, Months, NaiveDate};
use comfy_table::{ContentArrangement, Table, presets::UTF8_FULL};

#[derive(clap::Args, Debug)]
pub struct AnalysisRollingArgs {
    /// Fund name
    fund: String,
}

/// Rolling return statistics
pub struct RollingStats {
    pub mean: f64,
    pub std_dev: f64,
    pub min: f64,
    pub max: f64,
    pub iqm: f64,
    pub median: f64,
    pub count: usize,
}

#[derive(Debug, Clone)]
enum Period {
    OneWeek,
    TwoWeeks,
    OneMonth,
    OneQuarter,
    SixMonths,
    OneYear,
    ThreeYears,
    FiveYears,
}

impl Period {
    pub fn add_to(&self, start: NaiveDate) -> NaiveDate {
        match self {
            Period::OneWeek => start + Duration::days(7),
            Period::TwoWeeks => start + Duration::days(14),

            Period::OneMonth => start + Months::new(1),
            Period::OneQuarter => start + Months::new(3),
            Period::SixMonths => start + Months::new(6),

            Period::OneYear => start + Months::new(12),
            Period::ThreeYears => start + Months::new(36),
            Period::FiveYears => start + Months::new(60),
        }
    }
}

impl std::fmt::Display for Period {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let label = match self {
            Period::OneWeek => "1W",
            Period::TwoWeeks => "2W",
            Period::OneMonth => "1M",
            Period::OneQuarter => "3M",
            Period::SixMonths => "6M",
            Period::OneYear => "1Y",
            Period::ThreeYears => "3Y",
            Period::FiveYears => "5Y",
        };

        write!(f, "{label}")
    }
}

pub async fn handler(args: AnalysisRollingArgs) -> Result<()> {
    let details = get_fund_details(&args.fund).await?;

    let all_periods = vec![
        Period::OneWeek,
        Period::TwoWeeks,
        Period::OneMonth,
        Period::OneQuarter,
        Period::SixMonths,
        Period::OneYear,
        Period::ThreeYears,
        Period::FiveYears,
    ];

    let mut table = Table::new();

    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec!["Period", "Mean %", "Std %", "Min %", "Max %", "Median %", "IQM %", "N"]);

    for period in all_periods {
        if let Ok(stats) = rolling_return_stats(&details.prices, &period) {
            table.add_row(vec![
                format!("{}", period),
                format!("{:.2}", stats.mean * 100.0),
                format!("{:.2}", stats.std_dev * 100.0),
                format!("{:.2}", stats.min * 100.0),
                format!("{:.2}", stats.max * 100.0),
                format!("{:.2}", stats.median * 100.0),
                format!("{:.2}", stats.iqm * 100.0),
                stats.count.to_string(),
            ]);
        }
    }

    println!("Fund house: {}, Scheme: {}", details.fund_house, details.scheme_name);
    println!("{table}");
    Ok(())
}

/// Compute rolling return statistics for a given period.
fn rolling_return_stats(postings: &[PricePoint], period: &Period) -> Result<RollingStats> {
    ensure!(postings.len() > 2, "Cannot calculate stats on very small sets");

    let mut end = 0;
    let mut returns = Vec::new();

    for start in 0..postings.len() {
        let start = &postings[start];
        let target_date = period.add_to(start.date);
        let window_days = (target_date - start.date).num_days();

        while end < postings.len() && postings[end].date < target_date {
            end += 1;
        }
        if end >= postings.len() {
            break;
        }

        let return_rate = compute_return(start.amount, postings[end].amount, window_days);
        returns.push(return_rate);
    }

    // Statistics
    compute_stats(returns)
}

fn compute_return(start: i64, end: i64, days: i64) -> f64 {
    let ratio = end as f64 / start as f64;
    if days <= 365 { ratio - 1.0 } else { ratio.powf(365.25 / days as f64) - 1.0 }
}

fn compute_stats(values: Vec<f64>) -> Result<RollingStats> {
    ensure!(!values.is_empty(), "Cannot calculate stats on empty set");

    let count = values.len();
    let count_f = count as f64;
    let mean = values.iter().sum::<f64>() / count_f;
    let variance = values.iter().map(|v| ((v - mean) as f64).powi(2)).sum::<f64>() / count_f;
    let std_dev = variance.sqrt();
    let median = get_median(&values)?;
    let iqm = get_iqm(&values)?;

    Ok(RollingStats {
        count,
        mean,
        std_dev,
        median,
        iqm,
        min: values.iter().copied().fold(f64::INFINITY, f64::min),
        max: values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    })
}

fn get_median(values: &Vec<f64>) -> Result<f64> {
    ensure!(!values.is_empty(), "Cannot calculate median on empty set");

    let mut sorted = values.clone();
    let count = sorted.len();
    let mid_idx = count / 2;

    sorted.select_nth_unstable_by(mid_idx, |a, b| a.partial_cmp(b).unwrap());

    if count % 2 == 0 {
        let max_lower = sorted[..mid_idx].iter().copied().fold(f64::NEG_INFINITY, f64::max);
        return Ok((max_lower + sorted[mid_idx]) / 2.0);
    }

    Ok(sorted[mid_idx])
}

fn get_iqm(values: &Vec<f64>) -> Result<f64> {
    let n = values.len();
    ensure!(n >= 4, "Need at least 4 values for IQM");

    let mut data = values.clone();

    let q1_idx = n / 4;
    let q3_idx = 3 * n / 4;

    // Partition around Q1
    data.select_nth_unstable_by(q1_idx, |a, b| a.partial_cmp(b).unwrap());
    let mut upper = data[q1_idx..].to_vec();

    // Now partition the upper part around Q3
    let q3_relative = q3_idx - q1_idx;
    upper.select_nth_unstable_by(q3_relative, |a, b| a.partial_cmp(b).unwrap());

    // Values between Q1 and Q3
    let trimmed = &upper[..q3_relative];

    let sum: f64 = trimmed.iter().sum();
    Ok(sum / trimmed.len() as f64)
}
