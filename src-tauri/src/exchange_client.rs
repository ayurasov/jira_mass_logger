// Клиент для работы с Microsoft Exchange (EWS) — определение рабочих/выходных дней, встреч
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct ExchangeConnectionParams {
    pub ews_url: String,
    pub username: String,
    pub secret_ref: String,
}

#[tauri::command]
pub async fn test_exchange_connection(params: ExchangeConnectionParams) -> Result<bool, String> {
    // TODO: выполнить тестовый EWS-запрос GetUserAvailability
    let _ = params;
    Ok(true)
}
