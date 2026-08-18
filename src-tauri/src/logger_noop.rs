//! NoopLogger — пустой логгер для тестов: не пишет ничего на диск.
//! Используется в интеграционных тестах через `Arc<dyn LogSink>`.

use crate::logger::LogSink;

pub struct NoopLogger;

impl LogSink for NoopLogger {
    fn debug(&self, _module: &str, _msg: &str) {}
    fn info (&self, _module: &str, _msg: &str) {}
    fn warn (&self, _module: &str, _msg: &str) {}
    fn error(&self, _module: &str, _msg: &str) {}
}
