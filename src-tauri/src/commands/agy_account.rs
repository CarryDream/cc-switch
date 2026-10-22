//! Antigravity 官方账号的状态与专用命令（加号、切号走授权中心的通用 `auth_*` 命令）。

use std::sync::Arc;

use crate::services::agy_account::{AccountQuotaError, AgyAccountManager};
use crate::services::subscription::{CredentialStatus, SubscriptionQuota};

const TOOL: &str = "agy";

pub struct AgyAccountState(pub Arc<AgyAccountManager>);

/// 切号后提醒用：在跑的 agy 还用旧账号，续期时可能把旧登录写回钥匙串。
#[tauri::command]
pub async fn agy_account_is_running() -> Result<bool, String> {
    tokio::task::spawn_blocking(crate::services::agy_account::agy_running)
        .await
        .map_err(|error| error.to_string())
}

/// 授权中心逐个账号、以及绑了账号的官方卡显示的剩余额度：用该账号自己的令牌直接查，不用先切号。
#[tauri::command(rename_all = "camelCase")]
pub async fn agy_account_quota(
    account_id: String,
    state: tauri::State<'_, AgyAccountState>,
) -> Result<SubscriptionQuota, String> {
    agy_quota(&state.0, Some(&account_id)).await
}

/// Antigravity 官方登录的额度。指定账号就查它；不指定就查 agy 现在登着的号。macOS 及 Windows
/// 从 CC Switch 保存的令牌直接查询；其他平台继续通过 agy 的 `/usage` 查询。
pub(crate) async fn agy_quota(
    manager: &AgyAccountManager,
    account_id: Option<&str>,
) -> Result<SubscriptionQuota, String> {
    if !crate::services::agy_account::keychain::quota_read_supported() {
        return crate::services::subscription_agy::get_agy_subscription_quota().await;
    }
    let result = match account_id {
        Some(account_id) => manager.quota(account_id).await,
        None => match manager.live_quota().await {
            Ok(Some(tiers)) => Ok(tiers),
            Ok(None) => {
                // Windows 后台只读系统凭据，绝不以启动 agy 作为兜底；macOS 保留原有后备路径。
                #[cfg(target_os = "windows")]
                return Ok(SubscriptionQuota::error(
                    TOOL,
                    CredentialStatus::NotFound,
                    "No Antigravity sign-in was found in the system credential store".into(),
                ));
                #[cfg(not(target_os = "windows"))]
                return crate::services::subscription_agy::get_agy_subscription_quota().await;
            }
            Err(error) => Err(error),
        },
    };
    Ok(match result {
        Ok(tiers) => SubscriptionQuota {
            tool: TOOL.to_string(),
            credential_status: CredentialStatus::Valid,
            credential_message: None,
            success: true,
            tiers,
            extra_usage: None,
            reset_credits: None,
            credits_balance: None,
            error: None,
            queried_at: Some(chrono::Utc::now().timestamp_millis()),
        },
        Err(AccountQuotaError::NotFound) if cfg!(target_os = "windows") => {
            SubscriptionQuota::error(
                TOOL,
                CredentialStatus::NotFound,
                "The requested Antigravity account was not found in the local account store".into(),
            )
        }
        Err(AccountQuotaError::NotFound) => SubscriptionQuota::not_found(TOOL),
        Err(AccountQuotaError::NeedsReauth) => SubscriptionQuota::error(
            TOOL,
            CredentialStatus::Expired,
            "Antigravity sign-in expired".to_string(),
        ),
        Err(AccountQuotaError::Failed(message)) => {
            SubscriptionQuota::error(TOOL, CredentialStatus::Valid, message)
        }
    })
}
