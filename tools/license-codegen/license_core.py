"""
Общая логика формирования офлайн-лицензионного кода JiraTime.
Используется как CLI-скриптом (generate_code.py), так и GUI (license_gui.py).

Формат payload (совпадает с src-tauri/src/license.rs):
    version:u8(1) || days:u16 LE(2) || grant_id:16 bytes (UUID4) = 19 байт
Код = base32(payload || ed25519_signature(payload)), без padding, с дефисами
каждые 4 символа для удобства ввода (133 символа base32).
"""
import base64
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

PAYLOAD_VERSION = 1

PRESETS = {
    "trial_7": 7,
    "month_1": 30,
    "month_3": 90,
    "month_6": 183,
    "year_1": 365,
}

PRESET_LABELS = {
    7: "Пробный период — 7 дней",
    30: "Подписка — 1 месяц",
    90: "Подписка — 3 месяца",
    183: "Подписка — 6 месяцев",
    365: "Подписка — 1 год",
}


def _b32_no_pad(data: bytes) -> str:
    return base64.b32encode(data).decode().rstrip("=")


def _group_with_dashes(s: str, group=4) -> str:
    return "-".join(s[i:i + group] for i in range(0, len(s), group))


def load_private_key(path: str) -> Ed25519PrivateKey:
    with open(path, "rb") as f:
        raw = f.read()
    return Ed25519PrivateKey.from_private_bytes(raw)


def generate_code(private_key: Ed25519PrivateKey, days: int) -> str:
    if days < 0 or days > 65535:
        raise ValueError("days должен быть в диапазоне 0..65535")

    grant_id = uuid.uuid4().bytes  # 16 байт, случайный — не хранится нигде
    payload = bytes([PAYLOAD_VERSION]) + days.to_bytes(2, "little") + grant_id
    signature = private_key.sign(payload)
    blob = payload + signature  # 19 + 64 = 83 байта

    code_raw = _b32_no_pad(blob)  # 133 символа
    return _group_with_dashes(code_raw)


def label_for_days(days: int) -> str:
    return PRESET_LABELS.get(days, f"{days} дней")
