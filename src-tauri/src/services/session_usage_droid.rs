//! Import Factory Droid (`droid`，Factory AI 的 CLI；旧名 Factory) 的用量。
//!
//! ## 数据在哪
//!
//! ```text
//! ~/.factory/sessions/<workspace-slug>/<session-id>.jsonl          事件流（有每次调用的模型，没有用量）
//! ~/.factory/sessions/<workspace-slug>/<session-id>.settings.json  权威元数据 + 累计 token
//! ```
//!
//! 老版本把会话直接平铺在 `sessions/` 下，两种布局都扫。`.settings.json.bak` 是
//! 上一版快照，永远不读。
//!
//! ## 为什么是「按天 × 模型摊」而不是一条请求一行
//!
//! droid **不在会话正文里写逐条请求的用量**（实测 2026-11 的会话：`message` 行只有
//! `role`、`content`、`modelId`、`apiProvider`、`reasoningEffort`），只在旁车文件里
//! 写整场会话的累计计数器，而且每写完一批就整份重写。所以拿不到「一次调用用了多少
//! token」，只能把两次扫描之间的累计差值摊到这段时间里发生过的调用上。
//!
//! 摊法是：把正文里 `role = assistant` 且带 `modelId` 的行当作一次模型调用的锚点，
//! 按「日期 × 模型」分组计条数，差值按条数占比分摊。依据是本机 56 个单模型会话实测
//! 每次调用 `outputTokens` 中位 947、`cacheReadTokens` 中位 74084（同一会话里上下文大小
//! 基本恒定），所以**按调用次数摊**是一阶近似里最靠得住的。
//!
//! 不这么摊就会错得更多：本机 132 个有用量的会话里，26 个在会话中途换过模型、合计占
//! **53.5% 的 token**，而旁车里的 `model` 只是**最后一次选择**的模型；跨自然日的有 21 个、
//! 占 **44.8% 的 token**，只记一行的话全压到最后一天。
//!
//! ## 字段语义（本机 192 个真实会话实测）
//!
//! - `tokenUsage.inputTokens` **不含缓存**：缓存型会话里它比 `cacheReadTokens` 小两三个
//!   数量级（例：3.9M / 124M），所以按 `FRESH` 记账，droid 不进 `CACHE_INCLUSIVE_APP_TYPES`。
//! - `tokenUsage.outputTokens` **已含 `thinkingTokens`**：`lastCallTokenUsage` 里根本没有
//!   thinking 字段，thinking 是 Factory 自己按推理内容算的拆分，不能再加一次。
//! - `inclusiveTokenUsage` 含子代理，`tokenUsage` 只含本会话：只用后者，子代理会话自己
//!   也有旁车文件，各算一次，不重复。
//! - 计数器不严格单调（实测 71 个带 `.bak` 的会话里 1 个被清零重写），所以增量按分量
//!   饱和相减，回退当作「从 0 重新开始」，绝不写负数。
//! - 旁车文件的修改时间与正文最后一条消息的时间差：中位 0 秒、最大 116 秒，可当作
//!   「这次调用发生的时刻」；只有拿不到调用锚点时才退回它。
//!
//! 会话级只有 `assistantActiveTimeMs`，没有单次请求计时，`latency_ms` 记 0。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::{calculator::CostCalculator, parser::TokenUsage};
use crate::services::{
    session_usage::{
        load_sync_cursors, metadata_modified_nanos, parse_timestamp_millis, SessionSyncResult,
        SyncCursor,
    },
    sql_helpers::INPUT_TOKEN_SEMANTICS_FRESH,
    usage_stats::find_model_pricing,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const APP_TYPE: &str = "droid";
const DATA_SOURCE: &str = "droid_session";
const PROVIDER_TYPE: &str = "droid_session";

/// 会话里没记供应商归属时，用量归到这个占位供应商（用量页显示为
/// `Factory Droid (Session)`，见 `usage_stats::provider_name_coalesce`）。
const SESSION_PROVIDER_ID: &str = "_droid_session";

const SIDECAR_SUFFIX: &str = ".settings.json";

/// 游标键前缀。v1 是「一场会话只记一行、时间按文件修改时间」的旧口径，
/// 换到按天 × 模型分摊后整体重来一次，见 [`heal_legacy_state`]。
const CURSOR_PREFIX: &str = "droid:v2:";

/// Factory 的数据目录，`FACTORY_HOME` 可改（默认 `~/.factory`）。
pub fn droid_home() -> PathBuf {
    std::env::var_os("FACTORY_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| crate::config::get_home_dir().join(".factory"))
}

/// 会话目录：`<data dir>/sessions`。
pub fn session_dir() -> PathBuf {
    droid_home().join("sessions")
}

pub fn sync_droid_usage(db: &Database) -> Result<SessionSyncResult, AppError> {
    heal_legacy_state(db)?;
    sync_droid_usage_from(db, &session_dir())
}

/// 时间戳容差：允许一点时钟漂移，超过一天以后的一律当作写错单位。
const FUTURE_TOLERANCE_SECS: i64 = 86_400;

/// 清理只跑开发版才会留下的状态，让本轮整份重导：
///
/// - **毫秒时间戳**：早期开发版把 `created_at` 按毫秒写进库，时间落到五万年后，
///   用量页任何日期范围都筛不到；
/// - **v1 游标**：「一场会话只记一行」的旧口径，明细是按文件修改时间整场落一天的，
///   换成按天 × 模型分摊后必须重来。
///
/// 只碰 `data_source = 'droid_session'` 的行与 `droid:` 开头的游标，其他应用一条不动。
fn heal_legacy_state(db: &Database) -> Result<(), AppError> {
    let cutoff = chrono::Utc::now().timestamp() + FUTURE_TOLERANCE_SECS;
    let conn = lock_conn!(db.conn);
    let future_rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM proxy_request_logs
         WHERE data_source = ?1 AND created_at > ?2",
        rusqlite::params![DATA_SOURCE, cutoff],
        |row| row.get(0),
    )?;
    let legacy_cursors: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_log_sync WHERE file_path LIKE 'droid:v1:%'",
        [],
        |row| row.get(0),
    )?;
    if future_rows == 0 && legacy_cursors == 0 {
        return Ok(());
    }
    log::warn!(
        "[droid] 清理旧口径的用量（毫秒时间戳 {future_rows} 行、v1 游标 {legacy_cursors} 个），本轮整份重导"
    );
    conn.execute(
        "DELETE FROM proxy_request_logs WHERE data_source = ?1",
        [DATA_SOURCE],
    )?;
    // 收据和游标一起清，否则会因为「已导入过」而跳过。
    conn.execute(
        "DELETE FROM session_usage_dedup WHERE data_source = ?1",
        [DATA_SOURCE],
    )?;
    conn.execute(
        "DELETE FROM session_log_sync WHERE file_path LIKE 'droid:%'",
        [],
    )?;
    Ok(())
}

/// 累计计数器。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Totals {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache_read: u64,
    #[serde(default)]
    cache_creation: u64,
    /// 已落库的行序号，只用于 request_id。
    #[serde(default)]
    seq: u64,
}

impl Totals {
    fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_creation == 0
    }

    /// 本次相对上次水位的增量，分量饱和相减。
    fn growth_since(&self, previous: &Totals) -> Self {
        Self {
            input: self.input.saturating_sub(previous.input),
            output: self.output.saturating_sub(previous.output),
            cache_read: self.cache_read.saturating_sub(previous.cache_read),
            cache_creation: self.cache_creation.saturating_sub(previous.cache_creation),
            seq: previous.seq,
        }
    }
}

/// 一个「日期 × 模型」分组里累计的调用条数和最后一次调用时刻。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct GroupStat {
    #[serde(default)]
    count: u64,
    /// 组内最后一次调用的时间（秒）；0 表示没有可用时间戳。
    #[serde(default)]
    last_ts: i64,
}

/// 游标里存的东西：累计水位 + 正文已扫字节 + 各分组的调用条数。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct ParserState {
    #[serde(default)]
    totals: Totals,
    #[serde(default)]
    offset: i64,
    /// key 形如 `2026-11-15|claude-opus-5-5`。
    #[serde(default)]
    groups: BTreeMap<String, GroupStat>,
}

/// 一个旁车文件解析出来的东西。
struct Sidecar {
    totals: Totals,
    /// 旁车里的原始模型名，原样存进 `request_model` 备查。
    raw_model: Option<String>,
    /// 归一化后用于查价的模型名。
    model: String,
}

fn sync_droid_usage_from(db: &Database, root: &Path) -> Result<SessionSyncResult, AppError> {
    let mut result = SessionSyncResult::default();
    let cursors = load_sync_cursors(db)?;
    for (session_id, path) in sidecar_files(root) {
        result.files_scanned += 1;
        let key = format!("{CURSOR_PREFIX}{}", path.to_string_lossy());
        let cursor = cursors.get(&key);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                result
                    .errors
                    .push(format!("Cannot read droid sidecar {}: {error}", path.display()));
                continue;
            }
        };
        let modified = metadata_modified_nanos(&metadata);
        let size = metadata.len() as i64;
        if cursor.is_some_and(|cursor| {
            cursor.last_modified == modified && cursor.last_line_offset == size
        }) {
            continue;
        }
        match import_sidecar(db, &session_id, &key, &path, modified, size, cursor) {
            Ok((imported, skipped)) => {
                result.imported += imported;
                result.skipped += skipped;
            }
            Err(error) => result.errors.push(format!("droid {session_id}: {error}")),
        }
    }
    Ok(result)
}

/// 会话旁车文件：`<root>/<slug>/<id>.settings.json` 与老版本平铺的
/// `<root>/<id>.settings.json`。`.settings.json.bak` 不匹配后缀，自然排除。
fn sidecar_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Ok(nested) = std::fs::read_dir(&path) else {
                continue;
            };
            for file in nested.flatten() {
                push_sidecar(&mut files, &file.path());
            }
        } else {
            push_sidecar(&mut files, &path);
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn push_sidecar(files: &mut Vec<(String, PathBuf)>, path: &Path) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Some(session_id) = name.strip_suffix(SIDECAR_SUFFIX) else {
        return;
    };
    if session_id.is_empty() || !path.is_file() {
        return;
    }
    files.push((session_id.to_string(), path.to_path_buf()));
}

fn import_sidecar(
    db: &Database,
    session_id: &str,
    key: &str,
    path: &Path,
    modified: i64,
    size: i64,
    cursor: Option<&SyncCursor>,
) -> Result<(u32, u32), AppError> {
    let text = std::fs::read_to_string(path).map_err(|error| AppError::io(path, error))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mut state = cursor
        .and_then(|cursor| cursor.parser_state.as_deref())
        .and_then(|state| serde_json::from_str::<ParserState>(state).ok())
        .unwrap_or_default();
    let had_state = cursor.is_some_and(|cursor| cursor.parser_state.is_some());

    // 先把正文里新增的调用锚点收进来（按天 × 模型计数），再看累计涨了多少。
    let transcript = path.with_file_name(format!("{session_id}.jsonl"));
    let previous_groups = state.groups.clone();
    state.offset = scan_calls(&transcript, state.offset, &mut state.groups);

    let modified_secs = modified / 1_000_000_000;
    let mut imported = 0u32;
    let mut skipped = 0u32;
    if let Some(sidecar) = parse_sidecar(&value) {
        // 没有游标（第一次见到这个会话）时，累计值就是它的历史总量。
        let delta = if had_state {
            sidecar.totals.growth_since(&state.totals)
        } else {
            Totals {
                seq: 0,
                ..sidecar.totals
            }
        };
        if !delta.is_zero() {
            let shares = allocate(&delta, &previous_groups, &state.groups, &sidecar);
            let mut conn = lock_conn!(db.conn);
            let tx = conn.transaction()?;
            for share in shares {
                let seq = state.totals.seq.saturating_add(1);
                let request_id = format!("droid:{session_id}:{seq}:{}", share.key);
                // 永久收据：明细被保留策略剪掉后也不会重复导入。
                let fresh = tx.execute(
                    "INSERT OR IGNORE INTO session_usage_dedup
                         (data_source, request_id, semantic_id, has_entry_id)
                     VALUES (?1, ?2, ?2, 0)",
                    rusqlite::params![DATA_SOURCE, request_id],
                )?;
                if fresh == 0 {
                    skipped += 1;
                    continue;
                }
                let usage = TokenUsage {
                    input_tokens: clamp_u32(share.amount.input),
                    output_tokens: clamp_u32(share.amount.output),
                    cache_read_tokens: clamp_u32(share.amount.cache_read),
                    cache_creation_tokens: clamp_u32(share.amount.cache_creation),
                    cache_creation_1h_tokens: 0,
                    model: Some(share.model.clone()),
                    message_id: None,
                };
                let amounts = costs(&tx, &share.model, &usage);
                tx.execute(
                    "INSERT OR IGNORE INTO proxy_request_logs (
                        request_id, provider_id, app_type, model, request_model,
                        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                        input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
                        total_cost_usd, latency_ms, first_token_ms, status_code, session_id,
                        provider_type, is_streaming, cost_multiplier, created_at, data_source,
                        input_token_semantics
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                               0, NULL, 200, ?15, ?16, 1, '1', ?17, ?18, ?19)",
                    rusqlite::params![
                        request_id,
                        SESSION_PROVIDER_ID,
                        APP_TYPE,
                        share.model,
                        share.request_model,
                        usage.input_tokens,
                        usage.output_tokens,
                        usage.cache_read_tokens,
                        usage.cache_creation_tokens,
                        amounts[0],
                        amounts[1],
                        amounts[2],
                        amounts[3],
                        amounts[4],
                        session_id,
                        PROVIDER_TYPE,
                        if share.created_at > 0 {
                            share.created_at
                        } else {
                            modified_secs
                        },
                        DATA_SOURCE,
                        INPUT_TOKEN_SEMANTICS_FRESH,
                    ],
                )?;
                imported += 1;
            }
            // 水位对齐到本次快照：计数器回退（实测有会话被清零重写）时就当作
            // 从 0 重新开始，绝不写负数。
            state.totals = Totals {
                seq: state.totals.seq.saturating_add(1),
                ..sidecar.totals
            };
            save_cursor(&tx, key, modified, size, &state)?;
            tx.commit()?;
            return Ok((imported, skipped));
        }
        // 没有增长：水位对齐本次快照、序号不动，下一轮的增量还接在原来后面。
        state.totals = Totals {
            seq: state.totals.seq,
            ..sidecar.totals
        };
    }
    let conn = lock_conn!(db.conn);
    save_cursor(&conn, key, modified, size, &state)?;
    Ok((imported, skipped))
}

fn clamp_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// 一次分摊的结果：一段时间内同一个模型用掉的那部分 token。
struct Share {
    /// `日期|模型`，用于 request_id 与去重。
    key: String,
    model: String,
    request_model: String,
    created_at: i64,
    amount: Totals,
}

/// 把一次增量按「新增调用条数」摊到各分组上。
///
/// 先看这次同步新出现的 `(日期, 模型)` 锚点；一条新锚点都没有（比如只更新了尾部
/// 统计、或者这个会话的正文里根本没有 `modelId`）时，退回旁车给的模型 + 文件修改
/// 时间所在的那一天。
fn allocate(
    delta: &Totals,
    previous: &BTreeMap<String, GroupStat>,
    current: &BTreeMap<String, GroupStat>,
    sidecar: &Sidecar,
) -> Vec<Share> {
    // 没有 modelId 的锚点归到旁车给的模型上，同一「天 × 模型」合并成一档。
    let mut merged: BTreeMap<String, (u64, i64)> = BTreeMap::new();
    for (key, stat) in current {
        let before = previous.get(key).map_or(0, |group| group.count);
        let fresh = stat.count.saturating_sub(before);
        if fresh == 0 {
            continue;
        }
        let (day, model) = key.split_once('|').unwrap_or((key.as_str(), ""));
        let model = if model.is_empty() {
            sidecar.model.clone()
        } else {
            model.to_string()
        };
        let entry = merged.entry(format!("{day}|{model}")).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(fresh);
        entry.1 = entry.1.max(stat.last_ts);
    }
    let mut weights: Vec<(&String, u64, i64)> = merged
        .iter()
        .map(|(key, (count, last_ts))| (key, *count, *last_ts))
        .collect();
    weights.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0)));

    let fallback_ts = latest_call_ts(current);
    if weights.is_empty() {
        return vec![Share {
            key: format!("{}|{}", day_key(fallback_ts), sidecar.model),
            model: sidecar.model.clone(),
            request_model: sidecar
                .raw_model
                .clone()
                .unwrap_or_else(|| sidecar.model.clone()),
            created_at: fallback_ts,
            amount: *delta,
        }];
    }

    let total: u64 = weights.iter().map(|(_, count, _)| *count).sum();
    let counts: Vec<u64> = weights.iter().map(|(_, count, _)| *count).collect();
    let inputs = split(delta.input, &counts, total);
    let outputs = split(delta.output, &counts, total);
    let reads = split(delta.cache_read, &counts, total);
    let creations = split(delta.cache_creation, &counts, total);

    weights
        .iter()
        .enumerate()
        .filter_map(|(index, (key, _, last_ts))| {
            let amount = Totals {
                input: inputs[index],
                output: outputs[index],
                cache_read: reads[index],
                cache_creation: creations[index],
                seq: delta.seq,
            };
            if amount.is_zero() {
                return None;
            }
            let model = model_of_key(key);
            Some(Share {
                key: (*key).clone(),
                model: pricing_model(&model),
                request_model: model,
                created_at: *last_ts,
                amount,
            })
        })
        .collect()
}

/// 把 `total` 按 `counts` 的比例拆成整数，余数给条数最多的那一组，保证总和不变。
fn split(total: u64, counts: &[u64], weight_sum: u64) -> Vec<u64> {
    if weight_sum == 0 {
        return vec![0; counts.len()];
    }
    let mut out: Vec<u64> = counts
        .iter()
        .map(|count| total.saturating_mul(*count) / weight_sum)
        .collect();
    let assigned: u64 = out.iter().sum();
    if let Some(index) = counts.iter().enumerate().max_by_key(|(_, c)| **c).map(|(i, _)| i) {
        out[index] = out[index].saturating_add(total.saturating_sub(assigned));
    }
    out
}

/// 拿不到本次新增的调用锚点时，把增量记到最后一次已知调用的那天。
fn latest_call_ts(current: &BTreeMap<String, GroupStat>) -> i64 {
    current
        .values()
        .map(|group| group.last_ts)
        .filter(|ts| *ts > 0)
        .max()
        .unwrap_or(0)
}

fn key_of(ts: i64, model: Option<&str>) -> String {
    format!("{}|{}", day_key(ts), model.unwrap_or(""))
}

fn day_key(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn model_of_key(key: &str) -> String {
    key.split_once('|')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| key.to_string())
}

/// 从正文里扫出「每次模型调用」的锚点，累加到分组计数里。返回扫到的字节位置。
///
/// 只认 `type = message` 且 `message.role = assistant` 且带 `modelId` 的行：实测
/// 纯 `tool_use` 的 assistant 行是同一段回复的续块，没有 `modelId`，算进去会把调用
/// 次数放大一倍多。
fn scan_calls(path: &Path, from: i64, groups: &mut BTreeMap<String, GroupStat>) -> i64 {
    let Ok(mut file) = std::fs::File::open(path) else {
        return from;
    };
    let Ok(metadata) = file.metadata() else {
        return from;
    };
    let len = metadata.len() as i64;
    if from > len {
        // 文件被重写过：从头再来。
        groups.clear();
        return scan_calls(path, 0, groups);
    }
    if from == len {
        return from;
    }
    if file.seek(SeekFrom::Start(from as u64)).is_err() {
        return from;
    }
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut consumed = from;
    loop {
        line.clear();
        let Ok(read) = reader.read_until(b'\n', &mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        // 写到一半的尾行留到下一轮，否则这条调用会被算两遍。
        if line.last() != Some(&b'\n') {
            break;
        }
        consumed += read as i64;
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let Some((ts, model)) = call_anchor(&value) else {
            continue;
        };
        let entry = groups.entry(key_of(ts, model.as_deref())).or_default();
        entry.count = entry.count.saturating_add(1);
        entry.last_ts = entry.last_ts.max(ts);
    }
    consumed
}

/// 一行正文如果是「一次模型调用」，返回它的时间戳（秒）和模型名。
///
/// 老版本的 assistant 行只有纯 `tool_use` 块、不写 `modelId`（本机 47 个会话是这样，
/// 占 21% 的 token）。那种情况仍然返回时间戳、模型留空：时间维度还能按天摊，
/// 模型维度退回旁车给的那个。
fn call_anchor(value: &Value) -> Option<(i64, Option<String>)> {
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let ts = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_timestamp_millis)
        .map(|ms| ms / 1000)?;
    let model = message
        .get("modelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    Some((ts, model))
}

fn save_cursor(
    conn: &rusqlite::Connection,
    key: &str,
    modified: i64,
    size: i64,
    state: &ParserState,
) -> Result<(), AppError> {
    let serialized = serde_json::to_string(state)
        .map_err(|error| AppError::Database(format!("序列化 droid 游标失败: {error}")))?;
    conn.prepare_cached(
        "INSERT OR REPLACE INTO session_log_sync
             (file_path, last_modified, last_line_offset, last_synced_at, last_byte_offset, parser_state)
         VALUES (?1, ?2, ?3, unixepoch(), NULL, ?4)",
    )
    .and_then(|mut stmt| {
        stmt.execute(rusqlite::params![key, modified, size, serialized])
    })
    .map_err(|error| AppError::Database(format!("更新同步状态失败: {error}")))?;
    Ok(())
}

/// 五个金额（输入、输出、缓存读、缓存写、合计）；查不到价格的记 0，不代表免费。
fn costs(conn: &rusqlite::Connection, model: &str, usage: &TokenUsage) -> [String; 5] {
    // 自带 Key 的卡片名末尾带 Factory 自己的序号，价格表里没有这种写法：
    // 精确名先查，查不到再试去掉序号的变体。
    let pricing = find_model_pricing(conn, model)
        .or_else(|| strip_trailing_index(model).and_then(|name| find_model_pricing(conn, name)));
    pricing
        .map(|pricing| {
            let cost = CostCalculator::calculate_for_app(APP_TYPE, usage, &pricing, Decimal::ONE);
            [
                cost.input_cost,
                cost.output_cost,
                cost.cache_read_cost,
                cost.cache_creation_cost,
                cost.total_cost,
            ]
        })
        .unwrap_or([Decimal::ZERO; 5])
        .map(|value| value.to_string())
}

/// 旁车 JSON → 累计计数器 + 模型名。`tokenUsage` 整个缺失（会话刚建、或老版本）
/// 时返回 None：本轮不导入，游标照推。`tokenUsage` 是空对象或全零时照样返回，
/// 因为那代表「计数器被清零」（实测出现过），水位要跟着回到 0。
fn parse_sidecar(value: &Value) -> Option<Sidecar> {
    let usage = value.get("tokenUsage")?;
    let count = |field: &str| usage.get(field).and_then(Value::as_u64).unwrap_or(0);
    let totals = Totals {
        // thinking 已经算在 output 里，不再加一次。
        input: count("inputTokens"),
        output: count("outputTokens"),
        cache_read: count("cacheReadTokens"),
        cache_creation: count("cacheCreationTokens"),
        seq: 0,
    };
    let raw_model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let model = raw_model
        .as_deref()
        .map(pricing_model)
        .unwrap_or_else(|| "unknown".to_string());
    Some(Sidecar {
        totals,
        raw_model,
        model,
    })
}

/// 旁车里的模型名是 Factory 自己的写法，查价前要归一：
///
/// - `custom:<显示名>-[<方案名>]-<序号>`（自带 Key 的卡片）→ 取显示名，如 `GLM-4.7`；
/// - `<供应商>/<模型>`（BYOK 卡片）→ 由 `clean_model_id_for_pricing` 剥前缀；
/// - `auto` 之类没有对应模型的，交给查价层按占位符处理（结果为 0）。
fn pricing_model(model: &str) -> String {
    let model = model.trim();
    let model = model.strip_prefix("custom:").unwrap_or(model).trim();
    // `custom:GLM-4.7-[GLM-Coding-Plan-China]-0` 里 `-[` 之后是方案名和序号。
    let model = match model.split_once("-[") {
        Some((name, _rest)) => name.trim(),
        None => model,
    };
    if model.is_empty() {
        "unknown".to_string()
    } else {
        model.to_string()
    }
}

/// 去掉卡片名末尾的 1~2 位序号（`AG-Gemini-3.1-Pro-(High)-3` → `…-(High)`），
/// 只用于查价兜底：模型名本身可能就以数字结尾（`claude-fable-5`），所以精确
/// 命中优先，这里拿不到价格才试。
fn strip_trailing_index(model: &str) -> Option<&str> {
    let (name, tail) = model.rsplit_once('-')?;
    let is_index = (1..=2).contains(&tail.len()) && tail.chars().all(|c| c.is_ascii_digit());
    (is_index && !name.trim().is_empty()).then_some(name.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn write_session(root: &Path, session: &str, value: &Value, calls: &[(i64, &str)]) -> PathBuf {
        let dir = root.join("-D-proj");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{session}{SIDECAR_SUFFIX}"));
        fs::write(&path, serde_json::to_string_pretty(value).unwrap()).unwrap();
        let transcript = dir.join(format!("{session}.jsonl"));
        let body: String = calls
            .iter()
            .map(|(ts, model)| {
                let stamp = chrono::DateTime::from_timestamp(*ts, 0)
                    .unwrap()
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string();
                format!(
                    "{}\n",
                    json!({
                        "type": "message",
                        "timestamp": stamp,
                        "message": {"role": "assistant", "modelId": model, "content": []}
                    })
                )
            })
            .collect();
        fs::write(&transcript, body).unwrap();
        path
    }

    fn sidecar(model: &str, input: u64, output: u64, cache_read: u64, cache_creation: u64) -> Value {
        json!({
            "assistantActiveTimeMs": 146217,
            "model": model,
            "tokenUsage": {
                "inputTokens": input,
                "outputTokens": output,
                "cacheCreationTokens": cache_creation,
                "cacheReadTokens": cache_read,
                "thinkingTokens": 1975,
                "factoryCredits": 299198
            },
            "inclusiveTokenUsage": {
                "inputTokens": input + 1000,
                "outputTokens": output + 1000,
                "cacheCreationTokens": cache_creation,
                "cacheReadTokens": cache_read,
                "thinkingTokens": 1975
            }
        })
    }

    type Row = (
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        String,
        i64,
        i64,
    );

    fn rows(db: &Database) -> Vec<Row> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT request_id, provider_id, model, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_tokens, total_cost_usd,
                        input_token_semantics, created_at
                 FROM proxy_request_logs ORDER BY created_at, request_id",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    /// 2026-11-15 与 11-16 的秒级时间戳
    const DAY1: i64 = 1_763_164_800;
    const DAY2: i64 = 1_763_251_200;

    #[test]
    fn droid_splits_a_multi_model_session_by_call_counts_and_days() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        // 旁车只记「最后选的模型」，正文显示 3 次 opus（第一天）+ 1 次 glm（第二天）
        let calls = [
            (DAY1 + 100, "claude-opus-5-5"),
            (DAY1 + 200, "claude-opus-5-5"),
            (DAY1 + 300, "claude-opus-5-5"),
            (DAY2 + 100, "glm-5.2"),
        ];
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 400, 4000, 400_000, 40),
            &calls,
        );
        let result = sync_droid_usage_from(&db, root.path()).unwrap();
        assert_eq!(result.errors, Vec::<String>::new());
        assert_eq!(result.imported, 2);

        let all = rows(&db);
        assert_eq!(all.len(), 2);
        // 第一天：3/4 的 token，模型是 opus（旁车写的 glm 是错的）
        assert_eq!(all[0].2, "claude-opus-5-5");
        assert_eq!(all[0].9, DAY1 + 300);
        assert_eq!((all[0].3, all[0].4, all[0].5), (300, 3000, 300_000));
        // 第二天：1/4
        assert_eq!(all[1].2, "glm-5.2");
        assert_eq!(all[1].9, DAY2 + 100);
        assert_eq!((all[1].3, all[1].4, all[1].5), (100, 1000, 100_000));
        // 分摊后总量必须与旁车完全一致
        let sum: i64 = all.iter().map(|row| row.3 + row.4 + row.5 + row.6).sum();
        assert_eq!(sum, 400 + 4000 + 400_000 + 40);
        for row in &all {
            assert_eq!(row.1, SESSION_PROVIDER_ID);
            assert_eq!(row.8, INPUT_TOKEN_SEMANTICS_FRESH);
        }
    }

    #[test]
    fn droid_only_imports_the_growth_on_later_syncs() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_session(
            root.path(),
            "s1",
            &sidecar("claude-sonnet-4-5", 615, 10_200, 940_254, 71_067),
            &[(DAY1 + 100, "claude-sonnet-4-5")],
        );
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 1);
        // 没变化：整轮跳过
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 0);

        // 第二天又跑了一次，累计涨了
        let calls = [(DAY1 + 100, "claude-sonnet-4-5"), (DAY2 + 50, "glm-5.2")];
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 700, 10_400, 941_000, 71_067),
            &calls,
        );
        let result = sync_droid_usage_from(&db, root.path()).unwrap();
        assert_eq!((result.imported, result.skipped), (1, 0));
        let all = rows(&db);
        assert_eq!(all.len(), 2);
        // 增量 85/200/746/0 全归到新增的那次调用（glm，第二天）
        assert_eq!(all[1].2, "glm-5.2");
        assert_eq!(all[1].9, DAY2 + 50);
        assert_eq!(
            (all[1].3, all[1].4, all[1].5, all[1].6),
            (85, 200, 746, 0)
        );
    }

    #[test]
    fn droid_falls_back_to_the_sidecar_model_without_call_anchors() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        // 正文里没有带 modelId 的 assistant 行（老版本 / 只有旁车）
        write_session(root.path(), "s1", &sidecar("kimi-k2.5", 300, 400, 5000, 6000), &[]);
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 1);
        let all = rows(&db);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].2, "kimi-k2.5");
        assert!(all[0].9 > 1_600_000_000, "created_at 不是秒级时间戳");
    }

    #[test]
    fn droid_treats_a_counter_reset_as_a_restart() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 500, 900, 0, 0),
            &[(DAY1 + 10, "glm-5.2")],
        );
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 1);
        // 实测里出现过计数器被清零重写：不能写负数，也不能当成没变化。
        write_session(root.path(), "s1", &sidecar("glm-5.2", 0, 0, 0, 0), &[(DAY1 + 10, "glm-5.2")]);
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 0);
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 40, 60, 0, 0),
            &[(DAY1 + 10, "glm-5.2"), (DAY2 + 10, "glm-5.2")],
        );
        // 清零点之后只多了一次调用（第二天），增量整份归到它
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 1);
        let all = rows(&db);
        assert_eq!(all.len(), 2);
        assert_eq!((all[1].3, all[1].4), (40, 60));
    }

    #[test]
    fn droid_ignores_backup_sidecars_and_sessions_without_usage() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 10, 10, 0, 0),
            &[(DAY1 + 10, "glm-5.2")],
        );
        let dir = root.path().join("-D-proj");
        fs::copy(
            dir.join("s1.settings.json"),
            dir.join("s1.settings.json.bak"),
        )
        .unwrap();
        fs::write(dir.join("s1.settings.json"), r#"{"model":"auto"}"#).unwrap();
        fs::write(
            dir.join("s2.settings.json"),
            r#"{"model":"glm-5.2","tokenUsage":{}}"#,
        )
        .unwrap();

        let result = sync_droid_usage_from(&db, root.path()).unwrap();
        assert_eq!((result.imported, result.files_scanned), (0, 2));
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }

    #[test]
    fn droid_heals_rows_written_with_millisecond_timestamps() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        write_session(
            root.path(),
            "s1",
            &sidecar("glm-5.2", 300, 400, 0, 0),
            &[(DAY1 + 10, "glm-5.2")],
        );
        sync_droid_usage_from(&db, root.path()).unwrap();
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE proxy_request_logs SET created_at = ?1", [millis])
                .unwrap();
            // 旧口径的游标同时存在
            conn.execute(
                "INSERT INTO session_log_sync (file_path, last_modified, last_line_offset, last_synced_at)
                 VALUES ('droid:v1:/old/settings.json', 1, 2, 3)",
                [],
            )
            .unwrap();
        }
        heal_legacy_state(&db).unwrap();
        assert!(rows(&db).is_empty(), "脏行没清掉");
        let conn = db.conn.lock().unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_log_sync WHERE file_path LIKE 'droid:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "旧游标没清掉");
        drop(conn);
        // 清完能重新按新口径导入
        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 1);
    }

    #[test]
    fn droid_allocates_every_token_of_the_delta() {
        // 除不尽时余数给条数最多的组，总量必须守恒
        let counts = [3, 1, 1];
        let parts = split(1000, &counts, 5);
        assert_eq!(parts.iter().sum::<u64>(), 1000);
        assert!(parts[0] >= parts[1]);
        let parts = split(7, &[1, 1], 2);
        assert_eq!(parts.iter().sum::<u64>(), 7);
    }

    #[test]
    fn droid_maps_custom_card_model_names_for_pricing() {
        assert_eq!(
            pricing_model("custom:GLM-4.7-[GLM-Coding-Plan-China]-0"),
            "GLM-4.7"
        );
        assert_eq!(
            pricing_model("custom:AG-Gemini-3.1-Pro-(High)-3"),
            "AG-Gemini-3.1-Pro-(High)-3"
        );
        assert_eq!(
            strip_trailing_index("AG-Gemini-3.1-Pro-(High)-3"),
            Some("AG-Gemini-3.1-Pro-(High)")
        );
        // 以数字结尾的真模型名不能被截断
        assert_eq!(pricing_model("claude-fable-5"), "claude-fable-5");
        assert_eq!(
            pricing_model("vertex/anthropic/claude-sonnet-4-5"),
            "vertex/anthropic/claude-sonnet-4-5"
        );
        assert_eq!(pricing_model(""), "unknown");
    }

    #[test]
    fn droid_reads_call_anchors_from_the_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jsonl");
        let stamp = chrono::DateTime::from_timestamp(DAY1, 0)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let body = [
            json!({"type": "session_start", "cwd": "D:/x"}).to_string(),
            json!({"type": "message", "timestamp": stamp,
                   "message": {"role": "user", "content": []}})
            .to_string(),
            // 纯 tool_use 的 assistant 行（老版本不写 modelId）：算一次调用、模型留空
            json!({"type": "message", "timestamp": stamp,
                   "message": {"role": "assistant", "content": [{"type": "tool_use"}]}})
            .to_string(),
            json!({"type": "message", "timestamp": stamp,
                   "message": {"role": "assistant", "modelId": "kimi-k3", "content": []}})
            .to_string(),
        ];
        fs::write(&path, format!("{}\n", body.join("\n"))).unwrap();
        let mut groups = BTreeMap::new();
        let offset = scan_calls(&path, 0, &mut groups);
        assert_eq!(offset, fs::metadata(&path).unwrap().len() as i64);
        // 用户消息不算；两次 assistant 调用分别进「模型未知」和「kimi-k3」两档
        assert_eq!(groups.len(), 2);
        let unknown = &groups[&format!("{}|", day_key(DAY1))];
        assert_eq!(unknown.count, 1);
        let kimi = &groups[&format!("{}|kimi-k3", day_key(DAY1))];
        assert_eq!(kimi.count, 1);
        // 再扫一次不会重复计数
        let offset2 = scan_calls(&path, offset, &mut groups);
        assert_eq!(offset2, offset);
        assert_eq!(groups.values().map(|stat| stat.count).sum::<u64>(), 2);
    }

    #[test]
    fn droid_splits_by_day_even_when_calls_have_no_model() {
        let db = Database::memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        // 旁车只写 model、正文没有 modelId：按天摊，模型用旁车那个
        let dir = root.path().join("-D-proj");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("s1.settings.json"),
            serde_json::to_string(&sidecar("kimi-k3", 200, 200, 2000, 0)).unwrap(),
        )
        .unwrap();
        let body: String = [DAY1 + 10, DAY1 + 20, DAY2 + 30]
            .iter()
            .map(|ts| {
                let stamp = chrono::DateTime::from_timestamp(*ts, 0)
                    .unwrap()
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string();
                format!(
                    "{{}}\n",
                    // 空对象占位，下面替换成真实行
                )
                .replace(
                    "{}\n",
                    &format!(
                        "{}\n",
                        json!({"type": "message", "timestamp": stamp,
                               "message": {"role": "assistant", "content": [{"type": "tool_use"}]}})
                    ),
                )
            })
            .collect();
        fs::write(dir.join("s1.jsonl"), body).unwrap();

        assert_eq!(sync_droid_usage_from(&db, root.path()).unwrap().imported, 2);
        let all = rows(&db);
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|row| row.2 == "kimi-k3"));
        // 3 次调用：2 次第一天、1 次第二天 → 2/3 与 1/3，除不尽的余数给条数多的那组
        assert_eq!((all[0].3, all[0].4, all[0].5), (134, 134, 1334));
        assert_eq!((all[1].3, all[1].4, all[1].5), (66, 66, 666));
        let sum: i64 = all.iter().map(|row| row.3 + row.4 + row.5 + row.6).sum();
        assert_eq!(sum, 200 + 200 + 2000);
    }

    /// 用真实 `~/.factory` 核对：
    /// `CCS_DROID_SMOKE_HOME=<FACTORY_HOME> cargo test --lib real_droid_home -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_droid_home_usage_parses() {
        let home =
            PathBuf::from(std::env::var_os("CCS_DROID_SMOKE_HOME").expect("CCS_DROID_SMOKE_HOME"));
        let root = home.join("sessions");
        let db = Database::memory().unwrap();
        let result = sync_droid_usage_from(&db, &root).unwrap();
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(result.files_scanned > 0);
        let all = rows(&db);
        assert!(!all.is_empty());
        let now = chrono::Utc::now().timestamp();
        for row in &all {
            assert_eq!(row.1, SESSION_PROVIDER_ID);
            assert_eq!(row.8, INPUT_TOKEN_SEMANTICS_FRESH);
            assert!(row.3 + row.4 + row.5 + row.6 > 0);
            assert!(
                (1_600_000_000..=now + 86_400).contains(&row.9),
                "created_at 不是秒级时间戳: {}",
                row.9
            );
        }
        let total: i64 = all.iter().map(|row| row.3 + row.4 + row.5 + row.6).sum();
        eprintln!(
            "files={} imported={} skipped={} rows_total_tokens={}",
            result.files_scanned, result.imported, result.skipped, total
        );
    }
}
