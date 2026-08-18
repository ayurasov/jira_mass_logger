//! Безоперационный логгер для использования в тестах — не пишет ничего на диск.
use std::sync::Arc;

/// Трейт для подмены в sync_queue::start_worker при тестировании.
pub trait LogSink: Send + Sync + 'static {
    fn log_info(&self, msg: &str);
    fn log_error(&self, msg: &str);
    fn log_debug(&self, msg: &str);
}

/// Реализация LogSink, которая отбрасывает все сообщения.
pub struct NoopLogger;

impl LogSink for NoopLogger {
    fn log_info(&self, _msg: &str) {}
    fn log_error(&self, _msg: &str) {}
    fn log_debug(&self, _msg: &str) {}
}

/// Создает Arc<NoopLogger> — удобный фабрик для тестов.
pub fn noop_logger() -> Arc<NoopLogger> {
    Arc::new(NoopLogger)
}
